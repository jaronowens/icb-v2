import * as assert from 'node:assert/strict';
import { migrate, CURRENT_VERSION } from '../../repository/schema';
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
        assert.deepEqual(tables.sort(), ['Local', 'Media']);

        const localColumns = (await db.all('PRAGMA table_info(Local)')).map(column => column.name);
        assert.ok(localColumns.includes('width') && localColumns.includes('height'), 'Local has width and height (migration 2)');
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
