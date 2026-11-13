import * as path from 'node:path';
import * as sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { migrate } from '../../repository/schema';
import { startup } from '../../service/startupService';
import { createApp } from '../../app';

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
 * Returns `{ app, db }`. Close `db` when the suite is done.
 */
const createTestApp = async ({ directories = fixtureDirectories, sync = true, ready = undefined as Promise<unknown> | undefined } = {}) => {
    const db = await createTestDb();
    if (ready) {
        return { app: createApp({ db, directories, ready }), db };
    }
    const startupDone = sync ? startup(db, directories) : Promise.resolve();
    // createApp attaches its handlers before this await, so the status is 'ready' by the time it returns
    const app = createApp({ db, directories, ready: startupDone });
    await startupDone;
    return { app, db };
}

export { FIXTURES_PATH, fixtureDirectories, createTestDb, createTestApp, deferred };
