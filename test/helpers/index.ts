import * as path from 'node:path';
import * as os from 'node:os';
import * as sqlite3 from 'sqlite3';
import request from 'supertest';
import { open } from 'sqlite';
import { migrate } from '../../repository/schema';
import { startup } from '../../service/startupService';
import { createApp } from '../../app';
import { PerceptualHashJob } from '../../service/perceptualHashService';
import { createThumbnailService, ThumbnailService } from '../../service/thumbnailService';
import { ThumbnailJob } from '../../service/thumbnailJob';
import { FIXTURE_TAGS } from '../fixtures/tags';

/* The fixture images, served at /fixtures like a directories.json entry. See test/fixtures/README.md for what each file covers. */
const FIXTURES_PATH: string = path.join(__dirname, '..', 'fixtures', 'images');
const fixtureDirectories = [{ name: 'fixtures', path: FIXTURES_PATH }];

/* The folder all test thumbnail caches live in. Deleted once, after the whole run (see setup.ts). */
const testRoot = (): string => path.join(os.tmpdir(), `icb-test-${process.pid}`);
let thumbnailDirCount = 0;
/* A new, unused thumbnail cache folder for one app. It isn't created until a thumbnail is written into it. */
const testThumbnailDir = (): string => path.join(testRoot(), `thumbnails-${++thumbnailDirCount}`);

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
 * - `thumbnails`: a factory for the thumbnail service, given the cache folder (testThumbnailDir). Defaults to a real
 *   service with concurrency 2.
 * - `thumbnailJob`: a factory for the background thumbnail job to attach. Off by default, like `perceptualHashing`.
 * Returns `{ app, db, job, thumbnails, thumbnailJob }`. Close `db` when the suite is done, after `whenIdle()` of each job.
 */
const createTestApp = async ({
    directories = fixtureDirectories,
    sync = true,
    ready = undefined as Promise<unknown> | undefined,
    perceptualHashing = undefined as ((db) => PerceptualHashJob) | undefined,
    thumbnails: makeThumbnails = (dir: string) => createThumbnailService({ dir, concurrency: 2 }),
    thumbnailJob: makeThumbnailJob = undefined as ((db, thumbnails: ThumbnailService) => ThumbnailJob) | undefined,
} = {}) => {
    const db = await createTestDb();
    const job = perceptualHashing?.(db);
    const thumbnails = makeThumbnails(testThumbnailDir());
    const thumbnailJob = makeThumbnailJob?.(db, thumbnails);
    if (ready) {
        return { app: createApp({ db, directories, ready, perceptualHashing: job, thumbnails, thumbnailJob }), db, job, thumbnails, thumbnailJob };
    }
    const startupDone = sync ? startup(db, directories) : Promise.resolve();
    // createApp attaches its handlers before this await, so the status is 'ready' by the time it returns
    const app = createApp({ db, directories, ready: startupDone, perceptualHashing: job, thumbnails, thumbnailJob });
    await startupDone;
    return { app, db, job, thumbnails, thumbnailJob };
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

export { FIXTURES_PATH, fixtureDirectories, createTestDb, createTestApp, testThumbnailDir, deferred, tagsQuery, tagFixtures, insertTagLink };
