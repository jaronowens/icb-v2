import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { open } from 'sqlite';
import * as sqlite3 from 'sqlite3';
import { migrate, migrateTo } from '../../repository/schema';
import { startup } from '../../service/startupService';
import { computeFileHash } from '../../service/hashService';
import { FIXTURES_PATH, fixtureDirectories } from '../helpers';
import { GOLDEN_PHASH16 } from '../fixtures/goldenHashes';

const GIF = '2148362390_preview_success-small-flip.gif';
const ORPHAN_HASH = `phash16:${'0f'.repeat(32)}`;

/* Inserts a Local row for a fixture the way schema version 2 stored it, with its real size and mtime, so sync sees it as unchanged. */
const insertLegacyLocal = async (db, name: string, imageHash: string, mediaID: number) => {
    const source = `${FIXTURES_PATH}/${name}`;
    const stat = await fs.stat(source);
    const url = `http://localhost:3000/fixtures/${name}`;
    await db.run(
        `INSERT INTO Local (name, extension, is_video, directoryPath, source, imageURL, previewURL, size, mtimeMs, imageHash, width, height, mediaID)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        [name, path.extname(name).slice(1), FIXTURES_PATH, source, url, url, stat.size, Math.floor(stat.mtimeMs), imageHash, mediaID]
    );
};

const insertLegacyMedia = async (db, imageHash: string, { tags = null as string | null, isMounted = 1 } = {}): Promise<number> => {
    const result = await db.run(
        `INSERT INTO Media (type, isMounted, tags, imageHash, sourceID) VALUES ('Local', ?, ?, ?, NULL)`,
        [isMounted, tags, imageHash]
    );
    return result.lastID;
};

const sha256Of = (name: string) => computeFileHash(path.join(FIXTURES_PATH, name));
const localByName = async (db) => Object.fromEntries((await db.all('SELECT * FROM Local')).map(row => [row.name, row]));
const mediaById = async (db, id: number) => db.get('SELECT * FROM Media WHERE id = ?', [id]);

describe('upgrading perceptual identity hashes to sha256', () => {
    let db, sceneID, checkerID, gifID, orphanID;

    before(async () => {
        db = await open({ filename: ':memory:', driver: sqlite3.Database });
        await migrateTo(db, 2);
        // scene A and both its copies shared one Media row under the old perceptual hash
        const scenePhash = `phash16:${GOLDEN_PHASH16['scene-a.png']}`;
        sceneID = await insertLegacyMedia(db, scenePhash, { tags: 'kept' });
        checkerID = await insertLegacyMedia(db, `phash16:${GOLDEN_PHASH16['checker-b.jpg']}`);
        // gifs were already sha256
        gifID = await insertLegacyMedia(db, await sha256Of(GIF), { tags: 'gif-tag' });
        // a Media row whose files are long gone
        orphanID = await insertLegacyMedia(db, ORPHAN_HASH, { tags: 'orphan', isMounted: 0 });
        // scene-a.png first, so it's the lowest id in its group
        await insertLegacyLocal(db, 'scene-a.png', scenePhash, sceneID);
        await insertLegacyLocal(db, 'scene-a-copy.png', scenePhash, sceneID);
        await insertLegacyLocal(db, 'scene-a-small.png', scenePhash, sceneID);
        await insertLegacyLocal(db, 'checker-b.jpg', `phash16:${GOLDEN_PHASH16['checker-b.jpg']}`, checkerID);
        await insertLegacyLocal(db, GIF, await sha256Of(GIF), gifID);
        await db.run('UPDATE Media SET sourceID = (SELECT MIN(id) FROM Local WHERE Local.mediaID = Media.id)');

        await migrate(db);
        await startup(db, fixtureDirectories);
    });
    after(async () => { await db.close(); });

    it('keeps the Media row id and tags under the sha256 of its lowest-id file', async () => {
        const media = await mediaById(db, sceneID);
        assert.equal(media.imageHash, await sha256Of('scene-a.png'));
        assert.equal(media.tags, 'kept');
        assert.equal(media.isMounted, 1);
        assert.equal(media.perceptualHash, null, 'old perceptual hashes are not carried over');
        const local = await localByName(db);
        assert.equal(local['scene-a.png'].mediaID, sceneID);
        assert.equal(local['scene-a-copy.png'].mediaID, sceneID, 'the byte-identical copy stays linked');
    });

    it('splits a resized copy into a Media row of its own', async () => {
        const small = (await localByName(db))['scene-a-small.png'];
        assert.notEqual(small.mediaID, sceneID);
        const media = await mediaById(db, small.mediaID);
        assert.equal(media.imageHash, await sha256Of('scene-a-small.png'));
        assert.equal(media.tags, null);
        assert.equal(media.isMounted, 1);
    });

    it('re-keys single-file rows, and leaves sha256 rows alone', async () => {
        assert.equal((await mediaById(db, checkerID)).imageHash, await sha256Of('checker-b.jpg'));
        assert.equal((await localByName(db))['checker-b.jpg'].mediaID, checkerID);
        const gif = await mediaById(db, gifID);
        assert.deepEqual([gif.imageHash, gif.tags], [await sha256Of(GIF), 'gif-tag']);
    });

    it('leaves a Media row with no files untouched', async () => {
        const orphan = await mediaById(db, orphanID);
        assert.deepEqual([orphan.imageHash, orphan.tags, orphan.isMounted], [ORPHAN_HASH, 'orphan', 0]);
    });

    it('leaves no perceptual identity hashes, and does nothing on the next start', async () => {
        assert.equal((await db.get(`SELECT COUNT(*) AS n FROM Local WHERE imageHash NOT LIKE 'sha256:%'`)).n, 0);
        const localBefore = await db.all('SELECT * FROM Local ORDER BY id');
        const mediaBefore = await db.all('SELECT * FROM Media ORDER BY id');
        await startup(db, fixtureDirectories);
        assert.deepEqual(await db.all('SELECT * FROM Local ORDER BY id'), localBefore);
        assert.deepEqual(await db.all('SELECT * FROM Media ORDER BY id'), mediaBefore);
    });

    it('re-links a file that could only be re-keyed on a later start to its already re-keyed Media row', async () => {
        // as if scene-a-copy.png couldn't be read during the first re-key
        await db.run(`UPDATE Local SET imageHash = ? WHERE name = 'scene-a-copy.png'`, [`phash16:${GOLDEN_PHASH16['scene-a.png']}`]);
        await startup(db, fixtureDirectories);
        const copy = (await localByName(db))['scene-a-copy.png'];
        assert.equal(copy.imageHash, await sha256Of('scene-a-copy.png'));
        assert.equal(copy.mediaID, sceneID);
        assert.equal((await mediaById(db, sceneID)).imageHash, await sha256Of('scene-a.png'), 'the Media key is unchanged');
    });
});
