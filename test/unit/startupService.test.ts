import * as assert from 'node:assert/strict';
import { startup } from '../../service/startupService';
import { createTestDb, fixtureDirectories } from '../helpers';

/* Local rows keyed by file name. */
const localByName = async (db) => {
    const rows = await db.all('SELECT id, name, width, height, imageHash, mediaID FROM Local');
    return Object.fromEntries(rows.map(row => [row.name, row]));
}

describe('startup', () => {
    let db;
    before(async () => {
        db = await createTestDb();
        await startup(db, fixtureDirectories);
    });
    after(async () => { await db.close(); });

    it('adds a Local row for each supported file, and skips the rest', async () => {
        const local = await localByName(db);
        assert.deepEqual(Object.keys(local).sort(), [
            'checker-b.jpg', 'not-an-image.png', 'scene-a-copy.png', 'scene-a-small.png', 'scene-a.png',
        ]);
    });

    it('merges duplicate and resized copies into one Media row', async () => {
        const local = await localByName(db);
        const sceneA = local['scene-a.png'];
        assert.notEqual(sceneA.mediaID, -1, 'scene-a.png is linked to a Media row');
        assert.equal(local['scene-a-copy.png'].mediaID, sceneA.mediaID);
        assert.equal(local['scene-a-small.png'].mediaID, sceneA.mediaID);
        assert.notEqual(local['checker-b.jpg'].mediaID, sceneA.mediaID);

        const media = await db.all('SELECT id, isMounted FROM Media');
        assert.equal(media.length, 3, 'one row each for scene A, checker B and the unreadable file');
        assert.ok(media.every(row => row.isMounted === 1), 'every Media row is mounted');
    });

    it('stores real dimensions, and NULL for a file image-size can\'t read', async () => {
        const local = await localByName(db);
        assert.deepEqual([local['scene-a.png'].width, local['scene-a.png'].height], [256, 192]);
        assert.deepEqual([local['scene-a-small.png'].width, local['scene-a-small.png'].height], [128, 96]);
        assert.deepEqual([local['checker-b.jpg'].width, local['checker-b.jpg'].height], [40, 40]);
        assert.equal(local['not-an-image.png'].width, null);
        assert.equal(local['not-an-image.png'].height, null);
        assert.match(local['not-an-image.png'].imageHash, /^sha256:/);
    });

    it('leaves the rows alone when run again with no file changes', async () => {
        const localBefore = await db.all('SELECT * FROM Local ORDER BY id');
        const mediaBefore = await db.all('SELECT * FROM Media ORDER BY id');
        await startup(db, fixtureDirectories);
        assert.deepEqual(await db.all('SELECT * FROM Local ORDER BY id'), localBefore);
        assert.deepEqual(await db.all('SELECT * FROM Media ORDER BY id'), mediaBefore);
    });
});
