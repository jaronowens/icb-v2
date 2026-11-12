import * as assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp } from '../helpers';

/* Real dimensions of each fixture that can be a representative. The unreadable file has none. */
const DIMENSIONS = {
    'scene-a.png': [256, 192],
    'scene-a-copy.png': [256, 192],
    'scene-a-small.png': [128, 96],
    'checker-b.jpg': [40, 40],
    'not-an-image.png': [null, null],
};

describe('GET /media', () => {
    let app, db;
    before(async () => { ({ app, db } = await createTestApp()); });
    after(async () => { await db.close(); });

    it('returns one entry per distinct image, with its real width and height', async () => {
        const res = await request(app).get('/media').expect(200).expect('Content-Type', /json/);

        assert.equal(res.body.length, 3);
        // Which scene A file is the representative depends on directory listing order, so check
        // each entry against its own file instead of expecting a particular name.
        const sceneA = res.body.filter(entry => entry.name.startsWith('scene-a'));
        assert.equal(sceneA.length, 1, 'scene A and its copies are one entry');
        for (const entry of res.body) {
            assert.ok(entry.name in DIMENSIONS, `unexpected entry ${entry.name}`);
            assert.deepEqual([entry.width, entry.height], DIMENSIONS[entry.name], entry.name);
        }
    });

    it('returns an imageURL the app serves', async () => {
        const res = await request(app).get('/media').expect(200);
        const checker = res.body.find(entry => entry.name === 'checker-b.jpg');
        await request(app).get(new URL(checker.imageURL).pathname).expect(200).expect('Content-Type', 'image/jpeg');
    });
});
