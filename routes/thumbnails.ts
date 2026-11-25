import createError from 'http-errors';
import { Request, Response, NextFunction } from 'express';
import { getThumbnailSource } from '../repository/media';
import { THUMBNAIL_SIZES, THUMBNAIL_TYPES } from '../service/thumbnailSettings';
import { ThumbnailError, ThumbnailService } from '../service/thumbnailService';
import { RETRY_AFTER_SECONDS } from './middleware';

const THUMBNAIL_PATH: RegExp = /^\/([0-9a-f]{2})\/([0-9a-f]{64})-([1-9]\d*)\.webp$/; // no leading zeros, so each thumbnail has exactly one URL

/**
 * Makes a thumbnail that express.static didn't find (see createApp in app.ts), then serves it.
 * Mounted outside requireDatabase so a cache hit never waits on the database; this answers 503 itself until it's ready.
 * Unknown or malformed paths, unmounted media and other file types are a 404. A source that can't be decoded redirects
 * to the original; one that can't be read is a 404, and nothing is written for either.
 */
const thumbnailFallback = async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return next();
    }
    const match = THUMBNAIL_PATH.exec(req.path);
    if (!match || match[2].slice(0, 2) !== match[1] || !THUMBNAIL_SIZES.includes(Number(match[3]))) {
        return next();
    }
    const [, , hex, rawSize] = match;
    const size = Number(rawSize);

    const { dbStatus, dbError, db, thumbnails } = req.app.locals as { dbStatus: string, dbError: Error, db, thumbnails: ThumbnailService };
    if (dbStatus === 'starting') {
        res.set('Retry-After', String(RETRY_AFTER_SECONDS));
        throw createError(503, 'Database is starting, try again shortly');
    }
    if (dbStatus === 'failed') {
        throw createError(503, `Database failed to initialize: ${dbError?.message ?? 'unknown error'}`);
    }

    const row = await getThumbnailSource(await db, `sha256:${hex}`);
    if (!row || !THUMBNAIL_TYPES.includes(row.extension)) {
        throw createError(404, `Not found: ${req.method} ${req.path}`);
    }

    let file: string;
    try {
        file = await thumbnails.ensure(hex, size, row.source, 'request');
    } catch (err) {
        if (err instanceof ThumbnailError) {
            if (err.kind === 'decode') {
                return res.set('Cache-Control', 'no-cache').redirect(302, row.imageURL);
            }
            throw createError(404, `Not found: ${req.method} ${req.path}`);
        }
        throw err;
    }
    res.sendFile(file, { maxAge: '1y', immutable: true }, err => err && next(err));
}

export { thumbnailFallback };
