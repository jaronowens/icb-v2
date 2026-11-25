import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp, { Metadata } from 'sharp';
import { FIXTURES_PATH } from '../helpers';
import {
    concurrencyFromEnv, createThumbnailService, orientedSize, ThumbnailError, thumbnailDimensions,
} from '../../service/thumbnailService';
import { THUMBNAIL_SIZE } from '../../service/thumbnailSettings';

const randomHex = (): string => randomBytes(32).toString('hex');

/* Every file under `dir`, relative to it. Empty if `dir` was never created. */
const listFiles = async (dir: string): Promise<string[]> => {
    try {
        const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
        return entries.filter(entry => entry.isFile()).map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)));
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        }
        throw err;
    }
};

const rejectsWithKind = async (promise: Promise<unknown>, kind: 'read' | 'decode') => {
    await assert.rejects(promise, err => {
        assert.ok(err instanceof ThumbnailError, `expected a ThumbnailError, got ${err}`);
        assert.equal(err.kind, kind);
        return true;
    });
};

const errorWithCode = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

describe('thumbnailDimensions', () => {
    const cases: [number, number, number, number][] = [
        [3000, 2000, 1350, 900],
        [2000, 3000, 900, 1350],
        [1000, 20000, 135, 2700],   // long side capped at 3× the short side
        [600, 400, 600, 400],       // never upscaled
    ];
    for (const [width, height, expectedWidth, expectedHeight] of cases) {
        it(`sizes ${width}×${height} to ${expectedWidth}×${expectedHeight}`, () => {
            assert.deepEqual(thumbnailDimensions(width, height, 900), { width: expectedWidth, height: expectedHeight });
        });
    }

    it('keeps at least 1 px on each side, with the long side capped', () => {
        const { width, height } = thumbnailDimensions(1, 5000, 900);
        assert.ok(width >= 1 && height >= 1);
        assert.ok(height <= 2700);
    });
});

describe('orientedSize', () => {
    it('swaps width and height for orientation 6, and not for orientation 1, when autoOrient is missing', () => {
        assert.deepEqual(orientedSize({ width: 120, height: 80, orientation: 6 } as Metadata), { width: 80, height: 120 });
        assert.deepEqual(orientedSize({ width: 120, height: 80, orientation: 1 } as Metadata), { width: 120, height: 80 });
        assert.deepEqual(orientedSize({ width: 120, height: 80 } as Metadata), { width: 120, height: 80 });
    });

    it('uses sharp\'s autoOrient size when it has one', async () => {
        const meta = await sharp(path.join(FIXTURES_PATH, 'exif-rotated.jpg')).metadata();
        assert.deepEqual([meta.width, meta.height, meta.orientation], [120, 80, 6], 'the fixture is stored sideways');
        assert.deepEqual(orientedSize(meta), { width: 80, height: 120 });
    });
});

describe('concurrencyFromEnv', () => {
    it('reads THUMBNAIL_CONCURRENCY, and defaults to 2', () => {
        assert.equal(concurrencyFromEnv({ THUMBNAIL_CONCURRENCY: '3' }), 3);
        assert.equal(concurrencyFromEnv({}), 2);
        assert.equal(concurrencyFromEnv({ THUMBNAIL_CONCURRENCY: '0' }), 2);
        assert.equal(concurrencyFromEnv({ THUMBNAIL_CONCURRENCY: 'many' }), 2);
    });
});

describe('thumbnail service', () => {
    let tmp: string, dir: string;
    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'icb-thumbnail-service-'));
        dir = path.join(tmp, 'thumbnails');
    });
    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    /* Writes a solid-colour PNG of the given size into the temp folder and returns its path. */
    const makeImage = async (width: number, height: number): Promise<string> => {
        const file = path.join(tmp, `${width}x${height}-${randomHex().slice(0, 8)}.png`);
        await sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 200 } } }).png().toFile(file);
        return file;
    };

    it('writes a WebP at the computed size to pathFor, and only once', async () => {
        const thumbnails = createThumbnailService({ dir, concurrency: 2 });
        const source = await makeImage(3000, 2000);
        const hex = randomHex();

        const result = await thumbnails.ensure(hex, THUMBNAIL_SIZE, source, 'request');
        assert.equal(result, thumbnails.pathFor(hex, THUMBNAIL_SIZE));
        assert.equal(result, path.join(path.resolve(dir), hex.slice(0, 2), `${hex}-900.webp`));
        const meta = await sharp(result).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 1350, 900]);
        assert.equal(thumbnails.stats.generated, 1);

        const { mtimeMs } = await fs.stat(result);
        assert.equal(await thumbnails.ensure(hex, THUMBNAIL_SIZE, source, 'background'), result);
        assert.equal(thumbnails.stats.generated, 1, 'an existing thumbnail isn\'t made again');
        assert.equal((await fs.stat(result)).mtimeMs, mtimeMs);
        assert.deepEqual(await listFiles(dir), [path.join(hex.slice(0, 2), `${hex}-900.webp`)]);
    });

    it('keeps a small image at its own size', async () => {
        const thumbnails = createThumbnailService({ dir });
        const result = await thumbnails.ensure(randomHex(), THUMBNAIL_SIZE, await makeImage(600, 400), 'request');
        const meta = await sharp(result).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 600, 400]);
    });

    it('makes a thumbnail once for two concurrent calls', async () => {
        const thumbnails = createThumbnailService({ dir, concurrency: 2 });
        const source = await makeImage(1200, 800);
        const hex = randomHex();
        const first = thumbnails.ensure(hex, THUMBNAIL_SIZE, source, 'background');
        const second = thumbnails.ensure(hex, THUMBNAIL_SIZE, source, 'request');
        assert.equal(first, second, 'the second call shares the first one\'s promise');
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a, b);
        assert.equal(thumbnails.stats.generated, 1);
    });

    it('returns an existing thumbnail without reading the source', async () => {
        const thumbnails = createThumbnailService({ dir });
        const hex = randomHex();
        const final = thumbnails.pathFor(hex, THUMBNAIL_SIZE);
        await fs.mkdir(path.dirname(final), { recursive: true });
        await fs.writeFile(final, 'already here');
        assert.equal(await thumbnails.ensure(hex, THUMBNAIL_SIZE, path.join(tmp, 'missing.png'), 'request'), final);
        assert.equal(thumbnails.stats.generated, 0);
    });

    it('applies EXIF orientation, so a sideways-stored photo comes out upright', async () => {
        const thumbnails = createThumbnailService({ dir });
        const result = await thumbnails.ensure(randomHex(), THUMBNAIL_SIZE, path.join(FIXTURES_PATH, 'exif-rotated.jpg'), 'request');
        const { data, info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
        // stored 120×80; shown (and thumbnailed) 80×120, not stretched back to the stored shape
        assert.deepEqual([info.width, info.height], [80, 120]);
        // the red marker in the stored top-left corner is top-right once turned
        const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
        const isRed = ([r, g, b]: number[]) => r > 180 && g < 90 && b < 90;
        assert.ok(isRed(pixel(65, 10)), `top-right should be red, got ${pixel(65, 10)}`);
        assert.ok(!isRed(pixel(10, 10)), `top-left shouldn't be red, got ${pixel(10, 10)}`);
    });

    it('rejects an undecodable file with kind decode, and leaves nothing behind', async () => {
        const thumbnails = createThumbnailService({ dir });
        await rejectsWithKind(thumbnails.ensure(randomHex(), THUMBNAIL_SIZE, path.join(FIXTURES_PATH, 'not-an-image.png'), 'request'), 'decode');
        assert.deepEqual(await listFiles(dir), []);
        assert.equal(thumbnails.stats.generated, 0);
    });

    it('rejects a missing file with kind read, leaves nothing behind, and tries again next time', async () => {
        const thumbnails = createThumbnailService({ dir });
        const hex = randomHex();
        const source = path.join(tmp, 'appears-later.png');
        await rejectsWithKind(thumbnails.ensure(hex, THUMBNAIL_SIZE, source, 'request'), 'read');
        assert.deepEqual(await listFiles(dir), []);

        // the failure isn't cached: once the file is there, the same thumbnail is made
        await fs.copyFile(await makeImage(100, 100), source);
        assert.equal(await thumbnails.ensure(hex, THUMBNAIL_SIZE, source, 'request'), thumbnails.pathFor(hex, THUMBNAIL_SIZE));
        assert.equal(thumbnails.stats.generated, 1);
    });

    it('rejects invalid sizes and hashes without doing any work', async () => {
        const thumbnails = createThumbnailService({ dir });
        const source = await makeImage(10, 10);
        await assert.rejects(thumbnails.ensure(randomHex(), 512, source, 'request'), /Invalid thumbnail request/);
        await assert.rejects(thumbnails.ensure(randomHex().toUpperCase(), THUMBNAIL_SIZE, source, 'request'), /Invalid thumbnail request/);
        await assert.rejects(thumbnails.ensure('../etc', THUMBNAIL_SIZE, source, 'request'), /Invalid thumbnail request/);
        assert.deepEqual(await listFiles(dir), []);
    });

    describe('losing a rename race', () => {
        const OTHER_WRITER = Buffer.from('the other writer\'s thumbnail');

        it('succeeds when another writer made the file first and rename replaces it', async () => {
            const thumbnails = createThumbnailService({
                dir,
                rename: async (from, to) => {
                    await fs.writeFile(to, OTHER_WRITER);
                    await fs.rename(from, to);
                },
            });
            const hex = randomHex();
            const result = await thumbnails.ensure(hex, THUMBNAIL_SIZE, await makeImage(200, 100), 'request');
            assert.equal((await sharp(result).metadata()).format, 'webp');
            assert.deepEqual(await listFiles(dir), [path.join(hex.slice(0, 2), `${hex}-900.webp`)]);
        });

        for (const code of ['EPERM', 'EEXIST', 'EACCES']) {
            it(`treats ${code} as success when the final file exists, and deletes its temp file`, async () => {
                const thumbnails = createThumbnailService({
                    dir,
                    rename: async (_from, to) => {
                        await fs.writeFile(to, OTHER_WRITER);
                        throw errorWithCode(code);
                    },
                });
                const hex = randomHex();
                const result = await thumbnails.ensure(hex, THUMBNAIL_SIZE, await makeImage(200, 100), 'request');
                assert.equal(result, thumbnails.pathFor(hex, THUMBNAIL_SIZE));
                assert.deepEqual(await fs.readFile(result), OTHER_WRITER, 'the other writer\'s file is kept');
                assert.equal(thumbnails.stats.generated, 0, 'only a rename this call made counts');
                assert.deepEqual(await listFiles(dir), [path.join(hex.slice(0, 2), `${hex}-900.webp`)]);
            });
        }

        it('rethrows when rename fails and there\'s no final file, and deletes its temp file', async () => {
            const thumbnails = createThumbnailService({
                dir,
                rename: async () => { throw errorWithCode('EPERM'); },
            });
            await assert.rejects(thumbnails.ensure(randomHex(), THUMBNAIL_SIZE, await makeImage(200, 100), 'request'), { code: 'EPERM' });
            assert.deepEqual(await listFiles(dir), []);
            assert.equal(thumbnails.stats.generated, 0);
        });

        it('rethrows other rename errors even when the final file exists', async () => {
            const thumbnails = createThumbnailService({
                dir,
                rename: async (_from, to) => {
                    await fs.writeFile(to, OTHER_WRITER);
                    throw errorWithCode('ENOSPC');
                },
            });
            await assert.rejects(thumbnails.ensure(randomHex(), THUMBNAIL_SIZE, await makeImage(200, 100), 'request'), { code: 'ENOSPC' });
            assert.ok((await listFiles(dir)).every(file => !file.endsWith('.tmp')), 'no temp file is left');
        });
    });
});
