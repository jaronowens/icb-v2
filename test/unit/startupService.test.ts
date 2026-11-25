import * as assert from 'node:assert/strict';
import { startup, isValidDirectoryName } from '../../service/startupService';
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
    'gradient-c.jpeg': [48, 32],
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
    'transparent-corner.png': [64, 64],
    // stored 120×80 with EXIF orientation 6: the displayed size is stored
    'exif-rotated.jpg': [80, 120],
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

    it('merges byte-identical copies into one Media row, and nothing else', async () => {
        const local = await localByName(db);
        const sceneA = local['scene-a.png'];
        assert.notEqual(sceneA.mediaID, -1, 'scene-a.png is linked to a Media row');
        assert.equal(local['scene-a-copy.png'].mediaID, sceneA.mediaID);

        // Every other file is its own Media row, including the resized copy: 17 files, with the exact copy merged away
        const others = Object.values(local).filter((row: any) => row.name !== 'scene-a.png' && row.name !== 'scene-a-copy.png');
        const mediaIDs = new Set(others.map((row: any) => row.mediaID));
        assert.equal(mediaIDs.size, others.length, 'no other files share a Media row');
        assert.ok(!mediaIDs.has(sceneA.mediaID));

        const media = await db.all('SELECT id, isMounted FROM Media');
        assert.equal(media.length, 16);
        assert.ok(media.every(row => row.isMounted === 1), 'every Media row is mounted');
    });

    it('keeps alternate versions of the same artwork as separate Media rows', async () => {
        const local = await localByName(db);
        assert.notEqual(local['image-variant-1.jpg'].imageHash, local['image-variant-2.jpg'].imageHash);
        assert.notEqual(local['image-variant-1.jpg'].mediaID, local['image-variant-2.jpg'].mediaID);
    });

    it('stores real dimensions, and NULL for a file image-size can\'t read', async () => {
        const local = await localByName(db);
        for (const [name, dimensions] of Object.entries(DIMENSIONS)) {
            assert.deepEqual([local[name].width, local[name].height], dimensions, name);
        }
    });

    it('uses a sha256 identity hash for every file, and leaves perceptual hashes to the background job', async () => {
        const local = await localByName(db);
        for (const [name, row] of Object.entries(local)) {
            assert.match((row as any).imageHash, /^sha256:[0-9a-f]{64}$/, name);
        }
        const media = await db.all('SELECT imageHash, perceptualHash FROM Media');
        assert.ok(media.every(row => row.imageHash.startsWith('sha256:')), 'every Media key is sha256');
        assert.ok(media.every(row => row.perceptualHash === null), 'startup computes no perceptual hashes');
    });

    it('leaves the rows alone when run again with no file changes', async () => {
        const localBefore = await db.all('SELECT * FROM Local ORDER BY id');
        const mediaBefore = await db.all('SELECT * FROM Media ORDER BY id');
        await startup(db, fixtureDirectories);
        assert.deepEqual(await db.all('SELECT * FROM Local ORDER BY id'), localBefore);
        assert.deepEqual(await db.all('SELECT * FROM Media ORDER BY id'), mediaBefore);
    });
});

describe('reserved directory names', () => {
    it('rejects thumbnails, which /thumbnails serves', () => {
        assert.equal(isValidDirectoryName('thumbnails'), false);
        assert.equal(isValidDirectoryName('fixtures'), true);
    });

    it('skips a directory named thumbnails like any other invalid name', async () => {
        const db = await createTestDb();
        try {
            await startup(db, [{ name: 'thumbnails', path: fixtureDirectories[0].path }]);
            assert.equal((await db.get('SELECT COUNT(*) AS n FROM Local')).n, 0);
        } finally {
            await db.close();
        }
    });
});
