import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, testThumbnailDir } from '../helpers';
import { createPerceptualHashJob } from '../../service/perceptualHashService';
import { PERCEPTUAL_TYPES } from '../../service/perceptualHashSettings';
import { createThumbnailService, ThumbnailService } from '../../service/thumbnailService';
import { createThumbnailJob, ThumbnailJob } from '../../service/thumbnailJob';
import { THUMBNAIL_SIZE, THUMBNAIL_TYPES } from '../../service/thumbnailSettings';

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);
const hexOf = (imageHash: string): string => imageHash.replace('sha256:', '');

type FixtureRow = { id: number, name: string, extension: string, imageHash: string };
/* Every Media row with its representative file's name and extension. */
const fixtureRows = async (db): Promise<FixtureRow[]> => db.all(`
    SELECT Media.id AS id, Local.name AS name, lower(Local.extension) AS extension, Media.imageHash AS imageHash
    FROM Media JOIN Local ON Local.id = Media.sourceID ORDER BY Media.id
`);
/* The rows the job should make a thumbnail for: decodable images of a thumbnail type. */
const decodable = (rows: FixtureRow[]): FixtureRow[] =>
    rows.filter(row => THUMBNAIL_TYPES.includes(row.extension) && row.name !== 'not-an-image.png');
const markUnhashable = (db, name: string) =>
    db.run("UPDATE Media SET perceptualHash = 'none' WHERE sourceID IN (SELECT id FROM Local WHERE name = ?)", [name]);
const nextTick = () => new Promise(resolve => setImmediate(resolve));

describe('thumbnail job', () => {
    let app, db, thumbnails: ThumbnailService, job: ThumbnailJob;
    const passes: number[] = [];
    before(async () => {
        ({ app, db, thumbnails, thumbnailJob: job } = await createTestApp({
            thumbnailJob: (db, thumbnails) => createThumbnailJob(db, thumbnails, { onPassEnd: handled => passes.push(handled) }),
        }));
    });
    after(async () => {
        await job.whenIdle();
        await db.close();
    });

    it('makes a thumbnail for every decodable fixture, and none for undecodable, gif or mp4 files', async () => {
        const rows = await fixtureRows(db);
        const wanted = decodable(rows);
        assert.ok(wanted.length > 5);

        job.trigger();
        await job.whenIdle();

        for (const row of rows) {
            const made = await exists(thumbnails.pathFor(hexOf(row.imageHash), THUMBNAIL_SIZE));
            assert.equal(made, wanted.includes(row), row.name);
        }
        assert.equal(thumbnails.stats.generated, wanted.length);
        // not-an-image.png isn't marked unhashable yet (the perceptual hash job hasn't run), so it was attempted and failed
        assert.deepEqual(passes, [wanted.length + 1]);
        assert.deepEqual(job.status(), { state: 'idle', done: wanted.length + 1, total: wanted.length + 1 });
    });

    it('tries an image that is not marked unhashable again on the next pass, and makes nothing', async () => {
        const generated = thumbnails.stats.generated;
        passes.length = 0;
        job.trigger();
        await job.whenIdle();
        assert.deepEqual(passes, [1]);
        assert.equal(thumbnails.stats.generated, generated);
    });

    it('generates nothing on a pass with nothing missing, and goes straight to idle', async () => {
        await markUnhashable(db, 'not-an-image.png');
        const generated = thumbnails.stats.generated;
        passes.length = 0;
        job.trigger();
        await job.whenIdle();
        assert.deepEqual(passes, [0]);
        assert.equal(thumbnails.stats.generated, generated);
        assert.deepEqual(job.status(), { state: 'idle', done: 0, total: 0 });
    });

    it('runs exactly one more pass for triggers during a pass, and /status reports running, then idle', async () => {
        // a deleted cache is rebuilt
        await fs.rm(thumbnails.dir, { recursive: true, force: true });
        const wanted = decodable(await fixtureRows(db)).length;
        passes.length = 0;
        job.trigger();
        job.trigger();
        job.trigger();
        // wait for the pass to find its missing thumbnails
        while (job.status().state !== 'running') {
            await nextTick();
        }
        const running = (await request(app).get('/status').expect(200)).body.thumbnails;
        assert.equal(running.state, 'running');
        assert.equal(running.total, wanted);
        assert.ok(running.done <= running.total);

        await job.whenIdle();
        assert.deepEqual(passes, [wanted, 0], 'one pass, then exactly one more for the queued triggers');
        const idle = (await request(app).get('/status').expect(200)).body.thumbnails;
        assert.deepEqual(idle, { state: 'idle', done: 0, total: 0 });
    });

    it('reports the counts of the last pass that made thumbnails, while idle', async () => {
        await fs.rm(thumbnails.dir, { recursive: true, force: true });
        const wanted = decodable(await fixtureRows(db)).length;
        job.trigger();
        await job.whenIdle();
        assert.deepEqual((await request(app).get('/status').expect(200)).body.thumbnails, { state: 'idle', done: wanted, total: wanted });
    });
});

describe('thumbnail job and perceptual hashes', () => {
    it("skips a row whose perceptualHash is 'none', even when its file decodes", async () => {
        const { db, thumbnails, thumbnailJob: job } = await createTestApp({
            thumbnailJob: (db, thumbnails) => createThumbnailJob(db, thumbnails),
        });
        try {
            const rows = await fixtureRows(db);
            await markUnhashable(db, 'checker-b.jpg');
            await markUnhashable(db, 'not-an-image.png');
            job.trigger();
            await job.whenIdle();

            const skipped = rows.find(row => row.name === 'checker-b.jpg');
            assert.ok(skipped);
            assert.equal(await exists(thumbnails.pathFor(hexOf(skipped.imageHash), THUMBNAIL_SIZE)), false, 'skipped');
            for (const row of decodable(rows).filter(row => row !== skipped)) {
                assert.equal(await exists(thumbnails.pathFor(hexOf(row.imageHash), THUMBNAIL_SIZE)), true, row.name);
            }
            assert.deepEqual(job.status(), { state: 'idle', done: decodable(rows).length - 1, total: decodable(rows).length - 1 });
        } finally {
            await db.close();
        }
    });

    /* Wires the two jobs the way bin/www.ts does: the thumbnail job starts when the perceptual hash job goes idle. */
    it('starts the thumbnail pass only after the perceptual hash pass ends', async () => {
        const events: string[] = [];
        let unhashedAtFirstThumbnail: number | undefined;
        let thumbnailJob: ThumbnailJob | undefined;
        const { db, job, thumbnails, thumbnailJob: wired } = await createTestApp({
            perceptualHashing: db => createPerceptualHashJob(db, {
                workers: 2,
                onPassEnd: () => events.push('perceptual pass end'),
                onIdle: () => thumbnailJob.trigger(),
            }),
            thumbnails: dir => {
                const service = createThumbnailService({ dir, concurrency: 2 });
                // the first thumbnail made is the start of the thumbnail pass's work
                return {
                    ...service,
                    ensure: async (hex, size, source, priority) => {
                        if (!events.includes('thumbnail pass work')) {
                            events.push('thumbnail pass work');
                            unhashedAtFirstThumbnail = (await db.get(
                                `SELECT count(*) AS n FROM Media JOIN Local ON Local.id = Media.sourceID
                                 WHERE Media.perceptualHash IS NULL AND lower(Local.extension) IN (${PERCEPTUAL_TYPES.map(() => '?').join(', ')})`,
                                PERCEPTUAL_TYPES)).n;
                        }
                        return service.ensure(hex, size, source, priority);
                    },
                };
            },
            thumbnailJob: (db, thumbnails) => {
                thumbnailJob = createThumbnailJob(db, thumbnails, { onPassEnd: () => events.push('thumbnail pass end') });
                return thumbnailJob;
            },
        });
        try {
            assert.equal(wired, thumbnailJob);
            assert.deepEqual(wired.status(), { state: 'idle', done: 0, total: 0 });

            // only the perceptual hash job is triggered, as POST /media and startup do
            job.trigger();
            await job.whenIdle();
            await wired.whenIdle();

            assert.deepEqual(events, ['perceptual pass end', 'thumbnail pass work', 'thumbnail pass end']);
            assert.equal(unhashedAtFirstThumbnail, 0, 'every decodable image was hashed before the first thumbnail');
            // the perceptual hash job marked not-an-image.png, so the thumbnail pass didn't try it
            const rows = await fixtureRows(db);
            assert.equal(thumbnails.stats.generated, decodable(rows).length);
            assert.deepEqual(wired.status(), { state: 'idle', done: decodable(rows).length, total: decodable(rows).length });
        } finally {
            await db.close();
        }
    });
});

describe('thumbnail job failures', () => {
    it('reports failed, and recovers on the next pass', async () => {
        let broken = true;
        const { db } = await createTestApp({ sync: true });
        try {
            const flaky = { all: (sql: string, params?: unknown[]) => broken ? Promise.reject(new Error('boom')) : db.all(sql, params) };
            const thumbnails = createThumbnailService({ dir: testThumbnailDir(), concurrency: 2 });
            const job = createThumbnailJob(flaky, thumbnails);
            job.trigger();
            await job.whenIdle();
            assert.equal(job.status().state, 'failed');

            broken = false;
            job.trigger();
            await job.whenIdle();
            assert.equal(job.status().state, 'idle');
            assert.ok(thumbnails.stats.generated > 0);
        } finally {
            await db.close();
        }
    });
});
