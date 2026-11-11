import * as path from 'node:path';
import * as sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { migrate } from '../../repository/schema';
import { startup } from '../../service/startupService';
const { createApp } = require('../../app');

/* The fixture images, served at /fixtures like a directories.json entry. See test/fixtures/README.md for what each file covers. */
const FIXTURES_PATH: string = path.join(__dirname, '..', 'fixtures', 'images');
const fixtureDirectories = [{ name: 'fixtures', path: FIXTURES_PATH }];

/* Opens a fresh in-memory database with the current schema. Close it with `db.close()` when the test is done. */
const createTestDb = async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await migrate(db);
    return db;
}

/**
 * Builds the app against a fresh in-memory database.
 * - `directories`: defaults to the fixtures folder.
 * - `sync`: run startup sync and wait for it before returning (default true).
 * Returns `{ app, db }`. Close `db` when the suite is done.
 */
const createTestApp = async ({ directories = fixtureDirectories, sync = true } = {}) => {
    const db = await createTestDb();
    const app = createApp({ db, directories });
    if (sync) {
        await startup(db, directories);
    }
    return { app, db };
}

export { FIXTURES_PATH, fixtureDirectories, createTestDb, createTestApp };
