import * as path from 'node:path';
import * as sqlite3 from 'sqlite3';
import request from 'supertest';
import { open } from 'sqlite';
import { migrate } from '../../repository/schema';
import { startup } from '../../service/startupService';
import { createApp } from '../../app';
import { PerceptualHashJob } from '../../service/perceptualHashService';
import { FIXTURE_TAGS } from '../fixtures/tags';

/* The fixture images, served at /fixtures like a directories.json entry. See test/fixtures/README.md for what each file covers. */
const FIXTURES_PATH: string = path.join(__dirname, '..', 'fixtures', 'images');
const fixtureDirectories = [{ name: 'fixtures', path: FIXTURES_PATH }];

/* Opens a fresh in-memory database with the current schema. Close it with `db.close()` when the test is done. */
const createTestDb = async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await migrate(db);
    return db;
}

/* A promise with its resolve and reject exposed, for settling `ready` from a test. */
const deferred = <T = void>() => {
    let resolve: (value: T) => void;
    let reject: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/**
 * Builds the app against a fresh in-memory database.
 * - `directories`: defaults to the fixtures folder.
 * - `sync`: run startup sync and wait for it before returning (default true). Without it the database is
 *   reported ready straight away, empty apart from the schema.
 * - `ready`: pass your own promise (see `deferred`) to control the database status instead; `sync` is then ignored.
 * - `perceptualHashing`: a background perceptual hash job to attach (see createPerceptualHashJob). Tests start it
 *   themselves; without one, the app has no job and /status reports it idle.
 * Returns `{ app, db }`. Close `db` when the suite is done, after `perceptualHashing.whenIdle()` if there's a job.
 */
const createTestApp = async ({
    directories = fixtureDirectories,
    sync = true,
    ready = undefined as Promise<unknown> | undefined,
    perceptualHashing = undefined as ((db) => PerceptualHashJob) | undefined,
} = {}) => {
    const db = await createTestDb();
    const job = perceptualHashing?.(db);
    if (ready) {
        return { app: createApp({ db, directories, ready, perceptualHashing: job }), db, job };
    }
    const startupDone = sync ? startup(db, directories) : Promise.resolve();
    // createApp attaches its handlers before this await, so the status is 'ready' by the time it returns
    const app = createApp({ db, directories, ready: startupDone, perceptualHashing: job });
    await startupDone;
    return { app, db, job };
}

/* A JSON-URL-encoded tag array for PUT /media/:id?tags=... */
const tagsQuery = (tags: string[]): string => `tags=${encodeURIComponent(JSON.stringify(tags))}`;

/* Tags every fixture Media row with its tags from fixtures/tags.ts, through PUT /media/:id. Needs a synced app. */
const tagFixtures = async (app) => {
    const res = await request(app).get('/media').expect(200);
    for (const entry of res.body) {
        const tags = FIXTURE_TAGS[entry.name];
        if (tags) {
            await request(app).put(`/media/${entry.id}?${tagsQuery(tags)}`).expect(200);
        }
    }
}

/* Links a Media row to a tag directly in the database, creating the tag if needed. For tests that build rows by hand. */
const insertTagLink = async (db, mediaID: number, name: string) => {
    await db.run('INSERT OR IGNORE INTO Tags (name) VALUES (?)', [name]);
    await db.run('INSERT INTO Media_Tags (mediaID, tagID) SELECT ?, id FROM Tags WHERE name = ?', [mediaID, name]);
}

export { FIXTURES_PATH, fixtureDirectories, createTestDb, createTestApp, deferred, tagsQuery, tagFixtures, insertTagLink };
