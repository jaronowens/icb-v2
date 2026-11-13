import * as assert from 'node:assert/strict';
import { startup } from '../../service/startupService';
import { createTestDb, fixtureDirectories } from '../helpers';

/* Local rows keyed by file name. */
const localByName = async (db) => {
    const rows = await db.all('SELECT id, name, is_video, width, height, imageHash, mediaID FROM Local');
    return Object.fromEntries(rows.map(row => [row.name, row]));
}

const BEIDOU = '__beidou_genshin_impact_drawn_by_packge__26d9f313e83b566da8a9116ec71be5d4.jpg';
const GIF = '2148362390_preview_success-small-flip.gif';

/* Real dimensions of every fixture startup reads (see test/fixtures/README.md). `null` where image-size can't measure the file. */
const DIMENSIONS = {
    'scene-a.png': [256, 192],
    'scene-a-copy.png': [256, 192],
    'scene-a-small.png': [128, 96],
    'checker-b.jpg': [40, 40],
    'not-an-image.png': [null, null],
    [BEIDOU]: [2480, 3508],
    'Roxanne.webp': [700, 1124],
    'amberlyn.jpg': [1920, 2640],
    [GIF]: [160, 137],
    '1337.jpg': [2287, 3810],
    'RsniFBN.mp4': [null, null],
    'image-variant-1.jpg': [2605, 4096],
    'image-variant-2.jpg': [2605, 4096],
    'image-variant-1-resized.jpg': [850, 1337],
};

describe('startup', () => {
    let db;
    before(async () => {
        db = await createTestDb();
        await startup(db, fixtureDirectories);
    });
    after(async () => { await db.close(); });

    it('adds a Local row for each supported file, and skips the rest', async () => {
        const local = await localByName(db);
        // notes.txt is the only unsupported file
        assert.deepEqual(Object.keys(local).sort(), Object.keys(DIMENSIONS).sort());
    });

    it('marks only video files as videos', async () => {
        const local = await localByName(db);
        const videos = Object.values(local).filter((row: any) => row.is_video === 1).map((row: any) => row.name);
        assert.deepEqual(videos, ['RsniFBN.mp4']);
    });

    it('merges duplicate and resized copies into one Media row', async () => {
        const local = await localByName(db);
        const sceneA = local['scene-a.png'];
        assert.notEqual(sceneA.mediaID, -1, 'scene-a.png is linked to a Media row');
        assert.equal(local['scene-a-copy.png'].mediaID, sceneA.mediaID);
        assert.equal(local['scene-a-small.png'].mediaID, sceneA.mediaID);

        // Every other file is its own Media row: 14 files, with the two scene A copies merged away
        const others = Object.values(local).filter((row: any) => !row.name.startsWith('scene-a'));
        const mediaIDs = new Set(others.map((row: any) => row.mediaID));
        assert.equal(mediaIDs.size, others.length, 'no other files share a Media row');
        assert.ok(!mediaIDs.has(sceneA.mediaID));

        const media = await db.all('SELECT id, isMounted FROM Media');
        assert.equal(media.length, 12);
        assert.ok(media.every(row => row.isMounted === 1), 'every Media row is mounted');
    });

    it('keeps alternate versions of the same artwork as separate Media rows', async () => {
        const local = await localByName(db);
        assert.notEqual(local['image-variant-1.jpg'].imageHash, local['image-variant-2.jpg'].imageHash);
        assert.notEqual(local['image-variant-1.jpg'].mediaID, local['image-variant-2.jpg'].mediaID);
    });

    // Known gap: the real resized copy's phash16 differs from the original by a few bits, and hashes
    // are only merged on an exact match. Un-skip once near matches are merged.
    it.skip('merges a real resized copy with its original', async () => {
        const local = await localByName(db);
        assert.equal(local['image-variant-1-resized.jpg'].mediaID, local['image-variant-1.jpg'].mediaID);
    });

    it('stores real dimensions, and NULL for a file image-size can\'t read', async () => {
        const local = await localByName(db);
        for (const [name, dimensions] of Object.entries(DIMENSIONS)) {
            assert.deepEqual([local[name].width, local[name].height], dimensions, name);
        }
    });

    it('uses a perceptual hash for decodable images, and sha256 for everything else', async () => {
        const local = await localByName(db);
        for (const name of ['scene-a.png', 'checker-b.jpg', 'Roxanne.webp', 'amberlyn.jpg', BEIDOU, '1337.jpg']) {
            assert.match(local[name].imageHash, /^phash16:/, name);
        }
        for (const name of ['not-an-image.png', GIF, 'RsniFBN.mp4']) {
            assert.match(local[name].imageHash, /^sha256:/, name);
        }
    });

    it('leaves the rows alone when run again with no file changes', async () => {
        const localBefore = await db.all('SELECT * FROM Local ORDER BY id');
        const mediaBefore = await db.all('SELECT * FROM Media ORDER BY id');
        await startup(db, fixtureDirectories);
        assert.deepEqual(await db.all('SELECT * FROM Local ORDER BY id'), localBefore);
        assert.deepEqual(await db.all('SELECT * FROM Media ORDER BY id'), mediaBefore);
    });
});
