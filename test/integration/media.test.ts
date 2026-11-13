import * as assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp } from '../helpers';

/* Real dimensions of each fixture that can be a representative. Files image-size can't read have none. */
const DIMENSIONS = {
    'scene-a.png': [256, 192],
    'scene-a-copy.png': [256, 192],
    'scene-a-small.png': [128, 96],
    'checker-b.jpg': [40, 40],
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
};

describe('GET /media', () => {
    let app, db;
    before(async () => { ({ app, db } = await createTestApp()); });
    after(async () => { await db.close(); });

    it('returns one entry per distinct image, with its real width and height', async () => {
        const res = await request(app).get('/media').expect(200).expect('Content-Type', /json/);

        // 14 fixtures, with scene A's two copies merged into it
        assert.equal(res.body.length, 12);
        // Which scene A file is the representative depends on directory listing order, so check
        // each entry against its own file instead of expecting a particular name.
        const sceneA = res.body.filter(entry => entry.name.startsWith('scene-a'));
        assert.equal(sceneA.length, 1, 'scene A and its copies are one entry');
        for (const entry of res.body) {
            assert.ok(entry.name in DIMENSIONS, `unexpected entry ${entry.name}`);
            assert.deepEqual([entry.width, entry.height], DIMENSIONS[entry.name], entry.name);
        }
    });

    it('marks videos', async () => {
        const res = await request(app).get('/media').expect(200);
        const videos = res.body.filter(entry => entry.is_video).map(entry => entry.name);
        assert.deepEqual(videos, ['RsniFBN.mp4']);
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
