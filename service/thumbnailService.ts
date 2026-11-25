import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import sharp, { Metadata } from 'sharp';
import { createLimiter, Priority } from '../util/limiter';
import { LONG_SIDE_RATIO, THUMBNAIL_SIZES, thumbnailRelativePath } from './thumbnailSettings';

// each source is decoded once, so sharp's operation cache would only hold memory
sharp.cache(false);

type ThumbnailPriority = Priority;

/* Why a thumbnail couldn't be made: the source couldn't be read (missing file, disconnected drive), or sharp couldn't decode it. */
class ThumbnailError extends Error {
    kind: 'read' | 'decode';
    constructor(kind: 'read' | 'decode', message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'ThumbnailError';
        this.kind = kind;
    }
}

type ThumbnailService = {
    /* The cache folder, resolved to an absolute path. */
    dir: string;
    /* Absolute path of a thumbnail in `dir`, whether or not it exists yet. */
    pathFor(hex: string, size: number): string;
    /**
     * Makes the thumbnail if it doesn't exist, and resolves to pathFor(hex, size). Calls for a thumbnail that's already
     * being made share its promise. Rejects with a ThumbnailError for read and decode failures; other errors (writing
     * the cache) pass through as they are.
     */
    ensure(hex: string, size: number, source: string, priority: ThumbnailPriority): Promise<string>;
    /* `generated` counts thumbnails this service wrote itself (its own rename succeeded). For tests. */
    stats: { generated: number };
};

type ThumbnailServiceOptions = {
    dir: string,
    concurrency?: number,
    /* For tests: replaces fs.rename for the final step, to simulate losing a race with another writer. */
    rename?: (from: string, to: string) => Promise<void>,
};

const DEFAULT_CONCURRENCY: number = 2;
const HEX_PATTERN: RegExp = /^[0-9a-f]{64}$/;
/* What Windows' rename can fail with when another writer got there first, or the final file is open (being served). */
const RENAME_RACE_CODES: Set<string> = new Set(['EPERM', 'EEXIST', 'EACCES']);

/* How many thumbnails are made at once: THUMBNAIL_CONCURRENCY, or 2 if it's unset or not a positive integer. */
const concurrencyFromEnv = (env = process.env): number => {
    const value = Number(env.THUMBNAIL_CONCURRENCY);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

/**
 * A thumbnail's width and height (see "Sizing" in specs/10-thumbnails/spec.md): the short side scaled to `size`, the
 * long side capped at LONG_SIDE_RATIO × `size`, never upscaled, and at least 1 px each way. `width` and `height` are
 * measured after EXIF orientation.
 */
const thumbnailDimensions = (width: number, height: number, size: number): { width: number, height: number } => {
    const short = Math.min(width, height), long = Math.max(width, height);
    const scale = Math.min(size / short, (LONG_SIDE_RATIO * size) / long, 1);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/* An image's width and height after EXIF orientation. Orientations 5–8 turn the image a quarter turn, swapping the sides. */
const orientedSize = (meta: Metadata): { width: number, height: number } => {
    if (meta.autoOrient) {
        return { width: meta.autoOrient.width, height: meta.autoOrient.height };
    }
    return meta.orientation >= 5 && meta.orientation <= 8
        ? { width: meta.height, height: meta.width }
        : { width: meta.width, height: meta.height };
}

/* Whether a file exists. Any error other than "not found" also counts as missing, so the caller just tries to make it. */
const fileExists = async (file: string): Promise<boolean> => {
    try {
        return (await fs.stat(file)).isFile();
    } catch {
        return false;
    }
}

/**
 * The thumbnail cache (specs/10-thumbnails): makes WebP thumbnails into `dir` with sharp, on the main thread.
 * One instance is shared by the /thumbnails fallback and the background job, so they share the in-flight map and the
 * concurrency limit, and request work runs ahead of background work. `concurrency` defaults to THUMBNAIL_CONCURRENCY.
 * Subfolders are created when a thumbnail is written into them, so `dir` itself needn't exist.
 */
const createThumbnailService = ({ dir, concurrency = concurrencyFromEnv(), rename = fs.rename }: ThumbnailServiceOptions): ThumbnailService => {
    const root = path.resolve(dir);
    const limiter = createLimiter(concurrency);
    /* One promise per thumbnail being made, keyed by `<hex>-<size>`. Removed when it settles, so failures aren't cached. */
    const inFlight = new Map<string, Promise<string>>();
    const stats = { generated: 0 };

    const pathFor = (hex: string, size: number): string => path.join(root, thumbnailRelativePath(hex, size));

    /* Reads the source, makes the thumbnail into a temp file next to the final one, and renames it into place. */
    const generate = async (hex: string, size: number, source: string): Promise<string> => {
        const final = pathFor(hex, size);
        // another request, or the job, may have finished it while this one waited for a slot
        if (await fileExists(final)) {
            return final;
        }

        let buffer: Buffer;
        try {
            buffer = await fs.readFile(source);
        } catch (err) {
            throw new ThumbnailError('read', `Could not read ${source}: ${err.message}`, { cause: err });
        }

        let output: Buffer;
        try {
            // sharp allows one resize per pipeline, and no fit mode does "short side to size, long side capped", so
            // the target comes from the header first
            const { width, height } = orientedSize(await sharp(buffer).metadata());
            if (!(width > 0 && height > 0)) {
                throw new Error('no dimensions in the image header');
            }
            const target = thumbnailDimensions(width, height, size);
            output = await sharp(buffer)
                .rotate()   // apply EXIF orientation, unlike perceptual hashing: thumbnails are for people to look at
                .resize({ width: target.width, height: target.height, fit: 'fill' })
                .webp({ quality: 80 })
                .toBuffer();
        } catch (err) {
            throw new ThumbnailError('decode', `Could not decode ${source}: ${err.message}`, { cause: err });
        }

        // written beside the final file and renamed into place, so a half-written thumbnail is never served
        const temp = `${final}.${randomUUID()}.tmp`;
        try {
            await fs.mkdir(path.dirname(final), { recursive: true });
            await fs.writeFile(temp, output);
            try {
                await rename(temp, final);
                stats.generated++;
            } catch (err) {
                // Windows can refuse to replace a file another writer just made, or one that's open. Either way the
                // thumbnail is there, and it has the same bytes, because it's made from the same file.
                if (!(RENAME_RACE_CODES.has(err.code) && await fileExists(final))) {
                    throw err;
                }
            }
            return final;
        } finally {
            // gone already after a successful rename; force ignores that
            await fs.rm(temp, { force: true }).catch(err => console.warn(`Could not delete ${temp}: ${err.message}`));
        }
    };

    const ensure = (hex: string, size: number, source: string, priority: ThumbnailPriority): Promise<string> => {
        // callers validate first, so this is a programming error rather than a bad request
        if (!THUMBNAIL_SIZES.includes(size) || !HEX_PATTERN.test(hex)) {
            return Promise.reject(new Error(`Invalid thumbnail request: ${hex}-${size}`));
        }
        const key = `${hex}-${size}`;
        const existing = inFlight.get(key);
        if (existing) {
            // A request that finds the job's queued entry waits at background priority. Moving it up would need a
            // cancellable queue entry, and it only costs one tile some latency (see implementation.md).
            return existing;
        }
        const promise = limiter.run(() => generate(hex, size, source), priority)
            .finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
        return promise;
    };

    return { dir: root, pathFor, ensure, stats };
}

export {
    createThumbnailService, thumbnailDimensions, orientedSize, concurrencyFromEnv,
    ThumbnailError, ThumbnailService, ThumbnailPriority,
};
