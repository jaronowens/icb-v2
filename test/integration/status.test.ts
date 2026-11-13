import * as assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp, deferred } from '../helpers';

/* Readiness: /media answers 503 until startup sync settles, and /status reports where it is. */
describe('database readiness', () => {
    let app, db, ready;
    beforeEach(async () => {
        ready = deferred();
        ({ app, db } = await createTestApp({ directories: [], ready: ready.promise }));
    });
    afterEach(async () => { await db.close(); });

    it('answers 503 with Retry-After on /media while starting, and /status reports starting', async () => {
        await request(app).get('/status').expect(200, { database: 'starting' });
        for (const path of ['/media', '/media/1', '/media/unmounted']) {
            const res = await request(app).get(path).expect(503).expect('Content-Type', /json/).expect('Retry-After', '5');
            assert.match(res.body.error, /starting/, path);
        }
        await request(app).post('/media').send({ filepath: 'x.jpg' }).expect(503);
    });

    it('serves /media once startup has finished', async () => {
        ready.resolve();
        await ready.promise;
        await request(app).get('/status').expect(200, { database: 'ready' });
        await request(app).get('/media').expect(200, []);
    });

    it('answers 503 without Retry-After, and keeps running, if startup failed', async () => {
        ready.reject(new Error('boom'));
        await ready.promise.catch(() => {});
        await request(app).get('/status').expect(200, { database: 'failed' });
        const res = await request(app).get('/media').expect(503).expect('Content-Type', /json/);
        assert.match(res.body.error, /failed to initialize: boom/);
        assert.equal(res.headers['retry-after'], undefined);
    });

    it('does not gate the home page', async () => {
        await request(app).get('/').expect(200).expect('Content-Type', /html/);
    });
});
