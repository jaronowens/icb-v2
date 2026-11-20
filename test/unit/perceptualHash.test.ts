import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createTestApp, FIXTURES_PATH } from '../helpers';
import { GOLDEN_PHASH16 } from '../fixtures/goldenHashes';
import { hashBuffer } from '../../service/perceptualHashWorker';
import { createPerceptualHashJob } from '../../service/perceptualHashService';
import { PHASH_PREFIX, UNHASHABLE } from '../../service/perceptualHashSettings';

/* The largest distance from image-hash's hash seen on a fixture JPEG or WebP with the app's pipeline
   (amberlyn.jpg; see "Measurements" in specs/07-background-perceptual-hash/implementation.md). */
const JPEG_TOLERANCE = 8;

const hamming = (a: string, b: string): number => {
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
        let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (x) { distance += x & 1; x >>= 1; }
    }
    return distance;
};

const readFixture = (name: string) => fs.readFile(path.join(FIXTURES_PATH, name));

/* Each Media row's perceptual hash, keyed by its representative file's name. */
const perceptualByName = async (db): Promise<Record<string, string | null>> => {
    const rows = await db.all('SELECT Local.name, Media.perceptualHash FROM Media JOIN Local ON Local.id = Media.sourceID');
    return Object.fromEntries(rows.map(row => [row.name, row.perceptualHash]));
};

describe('hashBuffer', () => {
    it('matches image-hash exactly on PNGs, so blockhash was copied correctly (transparency included)', async () => {
        const pngs = Object.keys(GOLDEN_PHASH16).filter(name => name.endsWith('.png'));
        assert.ok(pngs.includes('transparent-corner.png'));
        for (const name of pngs) {
            assert.equal(await hashBuffer(await readFixture(name), { resize: null }), GOLDEN_PHASH16[name], name);
        }
    });

    it('stays within the measured distance of image-hash on JPEGs and WebPs', async () => {
        for (const [name, golden] of Object.entries(GOLDEN_PHASH16).filter(([name]) => !name.endsWith('.png'))) {
            const distance = hamming(await hashBuffer(await readFixture(name)), golden);
            assert.ok(distance <= JPEG_TOLERANCE, `${name}: distance ${distance}`);
        }
    });

    it('throws for a file that is not an image', async () => {
        await assert.rejects(hashBuffer(await readFixture('not-an-image.png')));
    });
});

describe('perceptual hash job', () => {
    let app, db, job;
    const passes: number[] = [];
    before(async () => {
        ({ app, db, job } = await createTestApp({
            perceptualHashing: db => createPerceptualHashJob(db, { workers: 2, onPassEnd: handled => passes.push(handled) }),
        }));
    });
    after(async () => {
        await job.whenIdle();
        await db.close();
    });

    it('hashes decodable images, marks undecodable ones, and leaves other types alone', async () => {
        job.trigger();
        await job.whenIdle();
        const hashes = await perceptualByName(db);
        for (const name of Object.keys(GOLDEN_PHASH16)) {
            if (name === 'scene-a.png' || name === 'scene-a-copy.png') {
                continue;   // one Media row for both; checked below
            }
            // the worker stores exactly what hashBuffer computes
            assert.equal(hashes[name], `${PHASH_PREFIX}${await hashBuffer(await readFixture(name))}`, name);
        }
        const sceneA = hashes['scene-a.png'] ?? hashes['scene-a-copy.png'];
        assert.equal(sceneA, `${PHASH_PREFIX}${GOLDEN_PHASH16['scene-a.png']}`);
        assert.equal(hashes['not-an-image.png'], UNHASHABLE);
        assert.equal(hashes['2148362390_preview_success-small-flip.gif'], null);
        assert.equal(hashes['RsniFBN.mp4'], null);
        assert.deepEqual(job.status(), { state: 'idle', done: passes[0], total: passes[0] });
    });

    it('hashes nothing on a second pass', async () => {
        const before = await db.all('SELECT * FROM Media ORDER BY id');
        passes.length = 0;
        job.trigger();
        await job.whenIdle();
        assert.deepEqual(passes, [0]);
        assert.deepEqual(await db.all('SELECT * FROM Media ORDER BY id'), before);
    });

    it('runs exactly one more pass for triggers during a pass, and keeps answering requests', async () => {
        await db.run('UPDATE Media SET perceptualHash = NULL');
        passes.length = 0;
        job.trigger();
        job.trigger();
        job.trigger();
        // wait for the pass to select its rows
        while (job.status().state !== 'running') {
            await new Promise(resolve => setImmediate(resolve));
        }
        const start = performance.now();
        const res = await request(app).get('/status').expect(200);
        const elapsed = performance.now() - start;
        assert.equal(res.body.perceptualHashing.state, 'running');
        assert.ok(res.body.perceptualHashing.done < res.body.perceptualHashing.total, 'answered mid-pass');
        // loose: it only catches decoding on the main thread, which blocks for much longer
        assert.ok(elapsed < 200, `GET /status took ${elapsed.toFixed(0)} ms during a pass`);

        await job.whenIdle();
        assert.equal(passes.length, 2, 'one pass, then exactly one more for the queued triggers');
        assert.ok(passes[0] > 0);
        assert.equal(passes[1], 0, 'the second pass finds nothing left');
    });
});

describe('perceptual hash job with files that change', () => {
    let app, db, job, tmp;
    const copy = (fixture: string) => fs.copyFile(path.join(FIXTURES_PATH, fixture), path.join(tmp, fixture));

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'icb-phash-'));
        ({ app, db, job } = await createTestApp({
            directories: [{ name: 'upload', path: tmp }],
            perceptualHashing: db => createPerceptualHashJob(db, { workers: 1 }),
        }));
    });
    afterEach(async () => {
        await job.whenIdle();
        await db.close();
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it('leaves a file it cannot read NULL, and hashes it on a later pass', async () => {
        await copy('checker-b.jpg');
        await request(app).post('/media').send({ filepath: path.join(tmp, 'checker-b.jpg') }).expect(201);
        await job.whenIdle();
        // forget the hash, and take the file away
        await db.run('UPDATE Media SET perceptualHash = NULL');
        await fs.rm(path.join(tmp, 'checker-b.jpg'));
        job.trigger();
        await job.whenIdle();
        assert.equal((await perceptualByName(db))['checker-b.jpg'], null);

        await copy('checker-b.jpg');
        job.trigger();
        await job.whenIdle();
        assert.match((await perceptualByName(db))['checker-b.jpg'], /^phash16:/);
    });

    it('is triggered by POST /media for a new image', async () => {
        await copy('Roxanne.webp');
        await request(app).post('/media').send({ filepath: path.join(tmp, 'Roxanne.webp') }).expect(201);
        await job.whenIdle();
        assert.match((await perceptualByName(db))['Roxanne.webp'], /^phash16:/);
    });
});
