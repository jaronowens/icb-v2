import * as assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp } from '../helpers';

describe('error responses', () => {
    let app, db;
    beforeEach(async () => { ({ app, db } = await createTestApp({ directories: [], sync: false })); });
    afterEach(async () => { await db.close(); });

    it('turns a failing query into a 500 JSON error, and keeps serving the next request', async () => {
        await db.run('DROP TABLE Local');
        // console.error is expected here; keep it out of the test output
        const consoleError = console.error;
        console.error = () => {};
        try {
            const res = await request(app).get('/media').expect(500).expect('Content-Type', /json/);
            assert.match(res.body.error, /no such table: Local/);
            assert.equal(res.body.stack, undefined, 'no stack trace outside development');
        } finally {
            console.error = consoleError;
        }
        await request(app).get('/status').expect(200, { database: 'ready', perceptualHashing: { state: 'idle', done: 0, total: 0 } });
        await request(app).get('/media/unmounted').expect(200, []);
    });

    it('answers unknown API paths with a 404 JSON error', async () => {
        for (const path of ['/media/1/nope', '/nope', '/fixtures/missing.jpg']) {
            const res = await request(app).get(path).expect(404).expect('Content-Type', /json/);
            assert.match(res.body.error, /Not found/, path);
        }
    });

    it('answers malformed JSON with a 400 JSON error', async () => {
        const res = await request(app).post('/media').set('Content-Type', 'application/json').send('{"filepath":').expect(400);
        assert.ok(res.body.error);
    });

    it('includes the stack trace in development', async () => {
        app.set('env', 'development');
        const res = await request(app).get('/nope').expect(404);
        assert.match(res.body.stack, /NotFoundError/);
    });

    it('keeps the pug error page for the home page', async () => {
        await request(app).post('/').expect(404).expect('Content-Type', /html/);
    });
});
