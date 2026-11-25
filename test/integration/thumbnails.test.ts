import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import request from 'supertest';
import { createTestApp, deferred, FIXTURES_PATH } from '../helpers';

/* The path part of a /media entry's previewURL, e.g. /thumbnails/ab/<hex>-900.webp. */
const thumbnailPath = (entry): string => new URL(entry.previewURL).pathname;

/* The hex in a /media entry's imageHash. */
const hexOf = (entry): string => entry.imageHash.replace('sha256:', '');

const findFiles = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
    return entries.map(entry => path.join(dir, entry));
}

describe('GET /thumbnails', () => {
    let app, db, thumbnails, entries;
    const entryNamed = (name: string) => entries.find(entry => entry.name === name);
    before(async () => {
        ({ app, db, thumbnails } = await createTestApp());
        entries = (await request(app).get('/media').expect(200)).body;
    });
    after(async () => {
        const leftovers = (await findFiles(thumbnails.dir)).filter(file => file.endsWith('.tmp'));
        await db.close();
        assert.deepEqual(leftovers, [], 'no temp files are left behind');
    });

    it('makes the thumbnail on the first request, then serves the file statically', async () => {
        const entry = entryNamed('amberlyn.jpg');
        const url = thumbnailPath(entry);
        const before = thumbnails.stats.generated;
        const first = await request(app).get(url).expect(200).expect('Content-Type', /image\/webp/);
        assert.match(first.headers['cache-control'], /immutable/);
        assert.match(first.headers['cache-control'], /max-age=31536000/);
        assert.equal(thumbnails.stats.generated, before + 1);

        const file = thumbnails.pathFor(hexOf(entry), 900);
        const mtime = (await fs.stat(file)).mtimeMs;
        const second = await request(app).get(url).expect(200).expect('Content-Type', /image\/webp/);
        assert.match(second.headers['cache-control'], /immutable/);
        assert.deepEqual(second.body, first.body);
        assert.equal(thumbnails.stats.generated, before + 1, 'the second request is a static hit');
        assert.equal((await fs.stat(file)).mtimeMs, mtime);
    });

    it('makes a thumbnail once for concurrent requests', async () => {
        const url = thumbnailPath(entryNamed('Roxanne.webp'));
        const before = thumbnails.stats.generated;
        const responses = await Promise.all([request(app).get(url), request(app).get(url)]);
        for (const res of responses) {
            assert.equal(res.status, 200);
            assert.match(res.headers['content-type'], /image\/webp/);
        }
        assert.equal(thumbnails.stats.generated, before + 1);
    });

    it('answers HEAD', async () => {
        const url = thumbnailPath(entryNamed('checker-b.jpg'));
        const res = await request(app).head(url).expect(200).expect('Content-Type', /image\/webp/);
        assert.deepEqual(res.body, {});
        await request(app).head(url).expect(200);
    });

    it('answers 404 for paths that are not a thumbnail of a known hash', async () => {
        const hex = hexOf(entryNamed('scene-a-small.png'));
        const folder = hex.slice(0, 2);
        const wrongFolder = folder === '00' ? '01' : '00';
        const paths = [
            '/thumbnails/nope.webp',
            `/thumbnails/${folder}/${hex}-900.png`,
            `/thumbnails/${folder}/${hex.toUpperCase()}-900.webp`,
            `/thumbnails/${folder}/${hex}-900.webp/extra`,
            `/thumbnails/${hex}-900.webp`,
            `/thumbnails/${wrongFolder}/${hex}-900.webp`,
            `/thumbnails/${folder}/${hex}-901.webp`,
            `/thumbnails/${folder}/${hex}-900.webp.tmp`,
            `/thumbnails/${folder}/${'0'.repeat(64)}-900.webp`,
            '/thumbnails/../app.ts',
            '/thumbnails/%2e%2e/%2e%2e/package.json',
        ];
        for (const url of paths) {
            const res = await request(app).get(url);
            assert.equal(res.status, 404, url);
        }
        for (const name of ['RsniFBN.mp4', '2148362390_preview_success-small-flip.gif']) {
            const h = hexOf(entryNamed(name));
            await request(app).get(`/thumbnails/${h.slice(0, 2)}/${h}-900.webp`).expect(404);
        }
    });

    it('answers 404 for media whose files are not mounted', async () => {
        const hex = 'ab'.repeat(32);
        await db.run(`INSERT INTO Media (type, isMounted, imageHash) VALUES ('local', 0, ?)`, [`sha256:${hex}`]);
        const res = await request(app).get(`/thumbnails/ab/${hex}-900.webp`).expect(404).expect('Content-Type', /json/);
        assert.match(res.body.error, /Not found/);
    });

    it('does not handle other methods', async () => {
        const url = thumbnailPath(entryNamed('gradient-c.jpeg'));
        await request(app).post(url).expect(404);
        await request(app).delete(url).expect(404);
    });

    it('redirects to the original when the source cannot be decoded, and writes nothing', async () => {
        const entry = entryNamed('not-an-image.png');
        const before = thumbnails.stats.generated;
        const res = await request(app).get(thumbnailPath(entry)).expect(302);
        assert.equal(res.headers.location, entry.imageURL);
        assert.equal(res.headers['cache-control'], 'no-cache');
        assert.equal(thumbnails.stats.generated, before);
        await assert.rejects(fs.stat(thumbnails.pathFor(hexOf(entry), 900)));
    });
});

describe('GET /thumbnails with a source deleted after sync', () => {
    let app, db, thumbnails, dir;
    before(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'icb-thumb-source-'));
        await fs.copyFile(path.join(FIXTURES_PATH, 'checker-b.jpg'), path.join(dir, 'temp.jpg'));
        ({ app, db, thumbnails } = await createTestApp({ directories: [{ name: 'temp', path: dir }] }));
    });
    after(async () => {
        await db.close();
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('answers 404, and writes nothing', async () => {
        const entry = (await request(app).get('/media').expect(200)).body[0];
        await fs.rm(path.join(dir, 'temp.jpg'));
        const before = thumbnails.stats.generated;
        await request(app).get(thumbnailPath(entry)).expect(404);
        assert.equal(thumbnails.stats.generated, before);
        assert.deepEqual(await findFiles(thumbnails.dir), []);
    });
});

describe('GET /thumbnails while the database is starting', () => {
    const url = `/thumbnails/ab/${'ab'.repeat(32)}-900.webp`;

    it('answers 503 with Retry-After until ready, then 404 for an unknown hash', async () => {
        const ready = deferred();
        const { app, db } = await createTestApp({ ready: ready.promise });
        try {
            const res = await request(app).get(url).expect(503);
            assert.equal(res.headers['retry-after'], '5');
            ready.resolve();
            await ready.promise;
            await request(app).get(url).expect(404);
        } finally {
            await db.close();
        }
    });

    it('answers 503 once startup has failed', async () => {
        const ready = deferred();
        const { app, db } = await createTestApp({ ready: ready.promise });
        try {
            ready.reject(new Error('boom'));
            await ready.promise.catch(() => {});
            const res = await request(app).get(url).expect(503);
            assert.match(res.body.error, /boom/);
        } finally {
            await db.close();
        }
    });
});
