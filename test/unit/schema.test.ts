import * as assert from 'node:assert/strict';
import { open } from 'sqlite';
import * as sqlite3 from 'sqlite3';
import { migrate, migrateTo, CURRENT_VERSION } from '../../repository/schema';
import { createTestDb } from '../helpers';

/* Every table, index and column definition, so two snapshots are equal only if the schema didn't change. */
const schemaSnapshot = async (db) => db.all('SELECT type, name, sql FROM sqlite_master ORDER BY type, name');

describe('migrate', () => {
    let db;
    beforeEach(async () => { db = await createTestDb(); });
    afterEach(async () => { await db.close(); });

    it('takes an empty database to CURRENT_VERSION', async () => {
        const { user_version } = await db.get('PRAGMA user_version');
        assert.equal(user_version, CURRENT_VERSION);

        const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map(row => row.name);
        assert.deepEqual(tables.sort(), ['Local', 'Media', 'Media_Tags', 'Tags']);

        const localColumns = (await db.all('PRAGMA table_info(Local)')).map(column => column.name);
        assert.ok(localColumns.includes('width') && localColumns.includes('height'), 'Local has width and height (migration 2)');

        const mediaColumns = (await db.all('PRAGMA table_info(Media)')).map(column => column.name);
        assert.ok(mediaColumns.includes('perceptualHash'), 'Media has perceptualHash (migration 3)');
        assert.ok(!mediaColumns.includes('tags'), 'Media.tags is replaced by the Tags table (migration 4)');
        assert.ok(!localColumns.includes('previewURL'), 'previewURL is computed, not stored (migration 5)');
    });

    it('keeps every Local row and drops previewURL (4 -> 5)', async () => {
        const old = await open({ filename: ':memory:', driver: sqlite3.Database });
        try {
            await migrateTo(old, 4);
            assert.ok((await old.all('PRAGMA table_info(Local)')).some(column => column.name === 'previewURL'));
            for (const name of ['a.png', 'b.jpg']) {
                await old.run(
                    `INSERT INTO Local (name, extension, is_video, directoryPath, source, imageURL, previewURL, size, mtimeMs, imageHash, mediaID)
                     VALUES (?, 'png', 0, '/d', ?, ?, ?, 10, 20, ?, -1)`,
                    [name, `/d/${name}`, `http://x/${name}`, `http://x/${name}`, `sha256:${name}`]
                );
            }
            await migrate(old);
            assert.equal((await old.get('PRAGMA user_version')).user_version, CURRENT_VERSION);
            assert.ok(!(await old.all('PRAGMA table_info(Local)')).some(column => column.name === 'previewURL'));
            assert.deepEqual(
                await old.all('SELECT name, imageURL, imageHash FROM Local ORDER BY id'),
                [
                    { name: 'a.png', imageURL: 'http://x/a.png', imageHash: 'sha256:a.png' },
                    { name: 'b.jpg', imageURL: 'http://x/b.jpg', imageHash: 'sha256:b.jpg' },
                ]
            );
        } finally {
            await old.close();
        }
    });

    it('keeps Media rows and their ids when moving tags into their own table (3 -> 4)', async () => {
        const old = await open({ filename: ':memory:', driver: sqlite3.Database });
        try {
            await migrateTo(old, 3);
            await old.run(`INSERT INTO Media (id, type, isMounted, tags, imageHash, sourceID) VALUES (7, 'Local', 1, NULL, 'sha256:a', NULL)`);
            await old.run(`INSERT INTO Media (id, type, isMounted, tags, imageHash, sourceID) VALUES (9, 'Local', 0, NULL, 'sha256:b', NULL)`);
            await migrate(old);
            assert.deepEqual(
                await old.all('SELECT id, imageHash, isMounted FROM Media ORDER BY id'),
                [{ id: 7, imageHash: 'sha256:a', isMounted: 1 }, { id: 9, imageHash: 'sha256:b', isMounted: 0 }]
            );
            assert.equal((await old.get('SELECT COUNT(*) AS n FROM Tags')).n, 0);
            assert.equal((await old.get('SELECT COUNT(*) AS n FROM Media_Tags')).n, 0);
        } finally {
            await old.close();
        }
    });

    it('allows each tag once, and each Media row to link a tag once', async () => {
        await db.run(`INSERT INTO Tags (name) VALUES ('elf')`);
        await assert.rejects(db.run(`INSERT INTO Tags (name) VALUES ('elf')`), /UNIQUE/);
        await db.run('INSERT INTO Media_Tags (mediaID, tagID) VALUES (1, 1)');
        await assert.rejects(db.run('INSERT INTO Media_Tags (mediaID, tagID) VALUES (1, 1)'), /UNIQUE/);
    });

    it('changes nothing when run again', async () => {
        const before = await schemaSnapshot(db);
        await migrate(db);
        assert.deepEqual(await schemaSnapshot(db), before);
        assert.equal((await db.get('PRAGMA user_version')).user_version, CURRENT_VERSION);
    });

    it('refuses a database newer than this code', async () => {
        await db.run(`PRAGMA user_version = ${CURRENT_VERSION + 1}`);
        await assert.rejects(migrate(db), /newer than this code supports/);
    });
});
