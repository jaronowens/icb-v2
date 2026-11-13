import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createTestApp, FIXTURES_PATH } from '../helpers';
import { computeFileHash } from '../../service/hashService';
import { startup } from '../../service/startupService';

const GIF = '2148362390_preview_success-small-flip.gif';

/* POST /media registers files in a temporary mounted directory, so the fixtures folder is never written to. */
describe('POST /media', () => {
    let app, db, tmp, directories;

    /* Copies a fixture into the mounted directory and returns its path there. */
    const addFile = async (fixture: string, as: string = fixture) => {
        const target = path.join(tmp, as);
        await fs.copyFile(path.join(FIXTURES_PATH, fixture), target);
        return target;
    };
    const post = (body: object) => request(app).post('/media').send(body);
    const localRows = () => db.all('SELECT id, name, size, mtimeMs, imageHash, mediaID FROM Local ORDER BY id');

    before(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'icb-media-post-'));
        directories = [{ name: 'upload', path: tmp }];
        // startup runs against the empty directory, so every file below is new to the database
        ({ app, db } = await createTestApp({ directories }));
    });
    after(async () => {
        await db.close();
        await fs.rm(tmp, { recursive: true, force: true });
    });

    let checkerID;

    it('creates a Media row and a Local row for a new file, and answers 201 with its id', async () => {
        const filepath = await addFile('checker-b.jpg');
        const res = await post({ filepath }).expect(201).expect('Content-Type', /json/);
        checkerID = res.body.id;
        assert.deepEqual(Object.keys(res.body), ['id']);

        const media = (await request(app).get(`/media/${checkerID}`).expect(200)).body;
        assert.equal(media.name, 'checker-b.jpg');
        assert.deepEqual([media.width, media.height], [40, 40]);
        assert.match(media.imageHash, /^phash16:/);
        assert.equal(media.isMounted, true);
        assert.deepEqual(media.files.map(file => file.name), ['checker-b.jpg']);
        // the URL is served from the mounted directory
        await request(app).get(new URL(media.imageURL).pathname).expect(200).expect('Content-Type', 'image/jpeg');

        const list = (await request(app).get('/media').expect(200)).body;
        assert.deepEqual(list.map(entry => entry.id), [checkerID]);
    });

    it('answers 200 with the same id, and changes nothing, for a file that is already registered', async () => {
        const before = await localRows();
        const res = await post({ filepath: path.join(tmp, 'checker-b.jpg') }).expect(200);
        assert.deepEqual(res.body, { id: checkerID });
        assert.deepEqual(await localRows(), before);
    });

    it('links a duplicate to the existing Media row and answers 200 with its id', async () => {
        const filepath = await addFile('checker-b.jpg', 'checker-b-copy.jpg');
        const res = await post({ filepath }).expect(200);
        assert.deepEqual(res.body, { id: checkerID });
        const media = (await request(app).get(`/media/${checkerID}`).expect(200)).body;
        assert.deepEqual(media.files.map(file => file.name), ['checker-b.jpg', 'checker-b-copy.jpg']);
    });

    it('mounts an unmounted Media row when a file with its hash is added', async () => {
        const imageHash = await computeFileHash(path.join(FIXTURES_PATH, 'scene-a.png'), 'png');
        const { lastID } = await db.run(
            `INSERT INTO Media (type, isMounted, tags, imageHash, sourceID) VALUES ('Local', 0, 'old-tag', ?, NULL)`, [imageHash]
        );
        const filepath = await addFile('scene-a.png');
        const res = await post({ filepath }).expect(200);
        assert.deepEqual(res.body, { id: lastID });

        const media = (await request(app).get(`/media/${lastID}`).expect(200)).body;
        assert.equal(media.isMounted, true);
        assert.equal(media.name, 'scene-a.png');
        assert.equal(media.tags, 'old-tag');
        await request(app).get('/media/unmounted').expect(200, []);
    });

    it('handles concurrent requests without nesting transactions', async () => {
        const [webp, gif] = await Promise.all([addFile('Roxanne.webp'), addFile(GIF)]);
        const [webpRes, gifRes, againRes] = await Promise.all([
            post({ filepath: webp }),
            post({ filepath: gif }),
            post({ filepath: gif }),
        ]);
        assert.equal(webpRes.status, 201);
        assert.deepEqual(gifRes.status + againRes.status, 201 + 200, 'one request creates the gif, the other finds it');
        assert.equal(gifRes.body.id, againRes.body.id);
        assert.notEqual(webpRes.body.id, gifRes.body.id);
    });

    describe('rejects with 400', () => {
        const cases: [string, () => Promise<object>, RegExp][] = [
            ['a missing body', async () => ({}), /filepath is required/],
            ['a filepath that is not a string', async () => ({ filepath: 5 }), /filepath is required/],
            ['a file that does not exist', async () => ({ filepath: path.join(tmp, 'missing.jpg') }), /File not found/],
            ['an unsupported file type', async () => ({ filepath: await addFile('notes.txt') }), /Unsupported file type: \.txt/],
            ['a file outside the mounted directories', async () => ({ filepath: path.join(FIXTURES_PATH, 'checker-b.jpg') }), /directories\.json/],
            ['a file in a subdirectory', async () => {
                await fs.mkdir(path.join(tmp, 'nested'), { recursive: true });
                return { filepath: await addFile('checker-b.jpg', path.join('nested', 'checker-b.jpg')) };
            }, /directories\.json/],
            ['a directory', async () => {
                await fs.mkdir(path.join(tmp, 'folder.jpg'), { recursive: true });
                return { filepath: path.join(tmp, 'folder.jpg') };
            }, /Not a file/],
        ];
        for (const [label, body, message] of cases) {
            it(label, async () => {
                const before = await localRows();
                const res = await post(await body()).expect(400).expect('Content-Type', /json/);
                assert.match(res.body.error, message);
                assert.deepEqual(await localRows(), before, 'nothing written');
            });
        }
    });

    // a nested suite, so Mocha runs it after the 400 cases above
    describe('the next startup sync', () => {
        it('keeps posted files without re-hashing them, and skips what the 400 cases left behind', async () => {
            // notes.txt, nested/ and folder.jpg/ are left over from the 400 cases
            const localBefore = await localRows();
            const mediaBefore = await db.all('SELECT id, imageHash, sourceID, isMounted FROM Media ORDER BY id');

            const lines: string[] = [];
            const consoleLog = console.log;
            console.log = (...args) => { lines.push(args.join(' ')); };
            try {
                await startup(db, directories);
            } finally {
                console.log = consoleLog;
            }

            assert.ok(lines.includes('upload: 0 new, 0 changed, 5 unchanged, 0 measured, 0 removed'), lines.join('\n'));
            assert.deepEqual(await localRows(), localBefore);
            assert.deepEqual(await db.all('SELECT id, imageHash, sourceID, isMounted FROM Media ORDER BY id'), mediaBefore);
        });
    });
});
