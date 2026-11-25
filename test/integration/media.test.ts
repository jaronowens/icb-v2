import * as assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp, insertTagLink } from '../helpers';

/* Real dimensions of each fixture that can be a representative. Files image-size can't read have none. */
const DIMENSIONS = {
    'scene-a.png': [256, 192],
    'scene-a-copy.png': [256, 192],
    'scene-a-small.png': [128, 96],
    'checker-b.jpg': [40, 40],
    'gradient-c.jpeg': [48, 32],
    'not-an-image.png': [null, null],
    '__beidou_genshin_impact_drawn_by_packge__26d9f313e83b566da8a9116ec71be5d4.jpg': [2480, 3508],
    'Roxanne.webp': [700, 1124],
    'amberlyn.jpg': [1920, 2640],
    '2148362390_preview_success-small-flip.gif': [160, 137],
    '1337.jpg': [2287, 3810],
    'RsniFBN.mp4': [null, null],
    'image-variant-1.jpg': [2605, 4096],
    'image-variant-2.jpg': [2605, 4096],
    'image-variant-1-resized.jpg': [850, 1337],
    'transparent-corner.png': [64, 64],
    'exif-rotated.jpg': [80, 120],
};

const MEDIA_NODE_KEYS = ['id', 'name', 'width', 'height', 'extension', 'is_video', 'source', 'tags', 'imageURL', 'imageHash', 'previewURL'];
const FILE_KEYS = ['id', 'name', 'extension', 'is_video', 'imageURL', 'previewURL', 'source'];

describe('GET /media', () => {
    let app, db;
    before(async () => { ({ app, db } = await createTestApp()); });
    after(async () => { await db.close(); });

    it('returns one entry per distinct image, with its real width and height', async () => {
        const res = await request(app).get('/media').expect(200).expect('Content-Type', /json/);

        // 17 fixtures, with scene A's byte-for-byte copy merged into it. The resized copy is its own entry.
        assert.equal(res.body.length, 16);
        // Which scene A file is the representative depends on directory listing order, so check
        // each entry against its own file instead of expecting a particular name.
        const sceneA = res.body.filter(entry => entry.name === 'scene-a.png' || entry.name === 'scene-a-copy.png');
        assert.equal(sceneA.length, 1, 'scene A and its exact copy are one entry');
        assert.ok(res.body.some(entry => entry.name === 'scene-a-small.png'), 'the resized copy is its own entry');
        for (const entry of res.body) {
            assert.ok(entry.name in DIMENSIONS, `unexpected entry ${entry.name}`);
            assert.deepEqual([entry.width, entry.height], DIMENSIONS[entry.name], entry.name);
        }
    });

    it('returns exactly the GET /media keys for each entry', async () => {
        const res = await request(app).get('/media').expect(200);
        for (const entry of res.body) {
            assert.deepEqual(Object.keys(entry), MEDIA_NODE_KEYS);
        }
    });

    it('computes previewURL: a thumbnail for decodable types, the original for the rest', async () => {
        const res = await request(app).get('/media').expect(200);
        const THUMBNAIL_FORM = /^http:\/\/localhost:3000\/thumbnails\/([0-9a-f]{2})\/([0-9a-f]{64})-900\.webp$/;
        for (const entry of res.body) {
            if (['jpg', 'jpeg', 'png', 'webp'].includes(entry.extension)) {
                const match = THUMBNAIL_FORM.exec(entry.previewURL);
                assert.ok(match, `${entry.name} has a thumbnail previewURL`);
                assert.equal(match[2], entry.imageHash.replace('sha256:', ''));
                assert.equal(match[1], match[2].slice(0, 2));
            } else {
                assert.equal(entry.previewURL, entry.imageURL, entry.name);
            }
        }
        assert.ok(res.body.some(entry => entry.extension === 'gif'));
        assert.ok(res.body.some(entry => entry.extension === 'mp4'));
    });

    it('serves every previewURL: a webp thumbnail for decodable types, the original for the rest', async () => {
        const res = await request(app).get('/media').expect(200);
        for (const entry of res.body) {
            const url = new URL(entry.previewURL).pathname;
            if (['jpg', 'jpeg', 'png', 'webp'].includes(entry.extension)) {
                if (entry.name === 'not-an-image.png') {
                    await request(app).get(url).expect(302);    // can't be decoded: redirects to the original
                } else {
                    await request(app).get(url).expect(200).expect('Content-Type', 'image/webp');
                }
            } else {
                const expected = entry.extension === 'gif' ? 'image/gif' : entry.extension === 'mp4' ? 'video/mp4' : null;
                assert.ok(expected, `${entry.name}: unexpected type ${entry.extension}`);
                await request(app).get(url).expect(200).expect('Content-Type', expected);
            }
        }
    });

    it('marks videos', async () => {
        const res = await request(app).get('/media').expect(200);
        const videos = res.body.filter(entry => entry.is_video).map(entry => entry.name);
        assert.deepEqual(videos, ['RsniFBN.mp4']);
    });

    it('answers is_video as a boolean, not as SQLite\'s 1/0', async () => {
        const res = await request(app).get('/media').expect(200);
        assert.ok(res.body.every(entry => typeof entry.is_video === 'boolean'));
        const detail = await request(app).get(`/media/${res.body[0].id}`).expect(200);
        assert.ok(detail.body.files.every(file => typeof file.is_video === 'boolean'));
    });

    for (const [name, contentType] of [
        ['checker-b.jpg', 'image/jpeg'],
        ['Roxanne.webp', 'image/webp'],
        ['2148362390_preview_success-small-flip.gif', 'image/gif'],
        ['RsniFBN.mp4', 'video/mp4'],
    ]) {
        it(`returns an imageURL the app serves for ${name}`, async () => {
            const res = await request(app).get('/media').expect(200);
            const entry = res.body.find(entry => entry.name === name);
            assert.ok(entry, `${name} is in the response`);
            await request(app).get(new URL(entry.imageURL).pathname).expect(200).expect('Content-Type', contentType);
        });
    }
});

describe('GET /media/:id and /media/unmounted', () => {
    let app, db, unmountedID;
    before(async () => {
        ({ app, db } = await createTestApp());
        // a Media row whose files are gone: unmounted, with tags that must stay reachable
        const result = await db.run(
            `INSERT INTO Media (type, isMounted, imageHash, sourceID) VALUES ('Local', 0, 'sha256:no-such-file', NULL)`
        );
        unmountedID = result.lastID;
        await insertTagLink(db, unmountedID, 'kept-tag');
    });
    after(async () => { await db.close(); });

    const entryNamed = async (...names: string[]) => {
        const res = await request(app).get('/media').expect(200);
        return res.body.find(entry => names.includes(entry.name));
    };

    it('returns a duplicate set with every file, representative first', async () => {
        const entry = await entryNamed('scene-a.png', 'scene-a-copy.png');
        const res = await request(app).get(`/media/${entry.id}`).expect(200).expect('Content-Type', /json/);
        const { isMounted, files, ...fields } = res.body;
        assert.deepEqual(fields, entry, 'same fields as the GET /media entry');
        assert.equal(isMounted, true);
        assert.deepEqual(files.map(file => file.name).sort(), ['scene-a-copy.png', 'scene-a.png']);
        assert.deepEqual(files.map(file => file.id), files.map(file => file.id).sort((a, b) => a - b), 'ordered by id');
        assert.equal(files[0].source, entry.source, 'representative first');
        for (const file of files) {
            assert.deepEqual(Object.keys(file), FILE_KEYS);
            assert.equal(file.previewURL, entry.previewURL, 'duplicates share one thumbnail');
        }
    });

    it('computes previewURL for each file in GET /media/:id the same way as GET /media', async () => {
        const list = await request(app).get('/media').expect(200);
        for (const entry of list.body) {
            const detail = await request(app).get(`/media/${entry.id}`).expect(200);
            assert.equal(detail.body.previewURL, entry.previewURL, entry.name);
            for (const file of detail.body.files) {
                const decodable = ['jpg', 'jpeg', 'png', 'webp'].includes(file.extension);
                assert.equal(file.previewURL, decodable ? entry.previewURL : file.imageURL, file.name);
            }
        }
    });

    it('returns a single file for media with no duplicates', async () => {
        const entry = await entryNamed('checker-b.jpg');
        const res = await request(app).get(`/media/${entry.id}`).expect(200);
        assert.deepEqual(res.body.files.map(file => file.name), ['checker-b.jpg']);
    });

    it('returns unmounted media from the Media row alone', async () => {
        const res = await request(app).get(`/media/${unmountedID}`).expect(200);
        assert.deepEqual(res.body, {
            id: unmountedID, name: null, width: null, height: null, extension: null, is_video: null, source: null,
            tags: ['kept-tag'], imageURL: null, imageHash: 'sha256:no-such-file', previewURL: null,
            isMounted: false, files: [],
        });
    });

    it('answers 404 for an id with no Media row', async () => {
        const res = await request(app).get('/media/9999').expect(404).expect('Content-Type', /json/);
        assert.match(res.body.error, /9999/);
    });

    for (const id of ['abc', '0', '-1', '1.5', '01', '99999999999999999999']) {
        it(`answers 400 for the id "${id}"`, async () => {
            const res = await request(app).get(`/media/${id}`).expect(400).expect('Content-Type', /json/);
            assert.match(res.body.error, /positive integer/);
        });
    }

    it('lists only unmounted media at /media/unmounted', async () => {
        const res = await request(app).get('/media/unmounted').expect(200);
        assert.deepEqual(res.body.map(entry => [entry.id, entry.isMounted, entry.tags]), [[unmountedID, false, ['kept-tag']]]);
        assert.deepEqual(Object.keys(res.body[0]), [...MEDIA_NODE_KEYS, 'isMounted']);
    });
});

describe('PUT /media and DELETE /media', () => {
    let app, db;
    before(async () => { ({ app, db } = await createTestApp({ directories: [], sync: false })); });
    after(async () => { await db.close(); });

    it('answers 404 for PUT /media, which has no id', async () => {
        const res = await request(app).put('/media').expect(404).expect('Content-Type', /json/);
        assert.match(res.body.error, /Not found/);
    });

    for (const path of ['/media/1', '/media']) {
        it(`answers 501 for DELETE ${path}`, async () => {
            const res = await request(app).delete(path).expect(501).expect('Content-Type', /json/);
            assert.match(res.body.error, /not implemented/);
        });
    }
});
