import createError from 'http-errors';
import { Request, Response, NextFunction } from 'express';

/* How long a client should wait before retrying while startup sync is still running. */
const RETRY_AFTER_SECONDS: number = 5;

/**
 * Answers 503 for routes that read the database until startup sync has finished (see createApp in app.ts).
 * A failed startup gets no Retry-After: it won't recover without a restart.
 */
const requireDatabase = (req: Request, res: Response, next: NextFunction) => {
    const { dbStatus, dbError } = req.app.locals;
    if (dbStatus === 'starting') {
        res.set('Retry-After', String(RETRY_AFTER_SECONDS));
        throw createError(503, 'Database is starting, try again shortly');
    }
    if (dbStatus === 'failed') {
        throw createError(503, `Database failed to initialize: ${dbError?.message ?? 'unknown error'}`);
    }
    next();
};

/* Parses a route parameter as a positive integer id, or throws a 400. */
const parseId = (raw: string): number => {
    const id = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) {
        throw createError(400, `Invalid id "${raw}": must be a positive integer`);
    }
    return id;
};

export { requireDatabase, parseId, RETRY_AFTER_SECONDS };
