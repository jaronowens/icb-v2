import * as fs from 'node:fs/promises';
import { getMediaNeedingThumbnail } from '../repository/media';
import { IDLE_STATUS, JobStatus } from './jobStatus';
import { ThumbnailError, ThumbnailService } from './thumbnailService';
import { THUMBNAIL_SIZE, THUMBNAIL_TYPES } from './thumbnailSettings';
import { UNHASHABLE } from './perceptualHashSettings';

/* The background job that makes thumbnails ahead of requests (specs/10-thumbnails). */
interface ThumbnailJob {
    /* Starts a pass over the mounted media, or asks the running one for another pass when it finishes. */
    trigger(): void;
    status(): JobStatus;
    /* Resolves when no pass is running or pending. For tests and shutdown. */
    whenIdle(): Promise<void>;
}

type ThumbnailJobOptions = {
    /* Called after each pass, with the number of thumbnails it needed to make. For tests. */
    onPassEnd?: (handled: number) => void,
};

const PROGRESS_INTERVAL: number = 100;
/* How many thumbnail files are checked for at once. */
const STAT_BATCH_SIZE: number = 50;
const HASH_PREFIX: string = 'sha256:';

/* Whether a file exists. Any error counts as missing, so the job just tries to make it. */
const exists = async (file: string): Promise<boolean> => {
    try {
        return (await fs.stat(file)).isFile();
    } catch {
        return false;
    }
}

/**
 * The background job that warms the thumbnail cache (specs/10-thumbnails). Each pass looks up the mounted Media rows
 * that could have a thumbnail, checks which thumbnail files are missing (the file existing is the record, so deleting
 * the cache folder rebuilds it), and makes those through `thumbnails`, at background priority so requests jump ahead.
 * bin/www.ts triggers it when the perceptual hash job goes idle. `db` may be the connection or the promise for one.
 */
const createThumbnailJob = (db, thumbnails: ThumbnailService, { onPassEnd }: ThumbnailJobOptions = {}): ThumbnailJob => {
    let status: JobStatus = { ...IDLE_STATUS };
    let pending = false;
    let loop: Promise<void> | null = null;

    /* Makes every missing thumbnail. Returns how many were missing. */
    const runPass = async (): Promise<number> => {
        const connection = await db;
        const rows = await getMediaNeedingThumbnail(connection, THUMBNAIL_TYPES, UNHASHABLE);
        const wanted = rows.map(row => ({ hex: row.imageHash.slice(HASH_PREFIX.length), source: row.source }));

        const missing: typeof wanted = [];
        for (let i = 0; i < wanted.length; i += STAT_BATCH_SIZE) {
            const batch = wanted.slice(i, i + STAT_BATCH_SIZE);
            const found = await Promise.all(batch.map(item => exists(thumbnails.pathFor(item.hex, THUMBNAIL_SIZE))));
            missing.push(...batch.filter((_, index) => !found[index]));
        }
        if (missing.length === 0) {
            status = { ...IDLE_STATUS };
            return 0;
        }
        status = { state: 'running', done: 0, total: missing.length };
        console.log(`Making ${missing.length} thumbnails`);

        // all at once: the service's limiter queues them, and a request for one of them shares its in-flight promise
        let failed = 0;
        await Promise.all(missing.map(async ({ hex, source }) => {
            try {
                await thumbnails.ensure(hex, THUMBNAIL_SIZE, source, 'background');
            } catch (err) {
                failed++;
                // read and decode failures are left for the next pass; anything else is the cache folder
                const kind = err instanceof ThumbnailError ? err.kind : 'write';
                console.warn(`Could not make a thumbnail for ${source} (${kind}): ${err.message}`);
            }
            status.done++;
            if (status.done % PROGRESS_INTERVAL === 0 || status.done === status.total) {
                console.log(`Made ${status.done}/${status.total} thumbnails (${failed} failed)`);
            }
        }));
        status = { ...status, state: 'idle' };
        return missing.length;
    };

    // The trigger, pending and loop handling below is the same as in createPerceptualHashJob. It's about 30 lines, so
    // it's copied instead of being pulled into a shared helper that would change a working job.
    const runLoop = async () => {
        do {
            pending = false;
            const handled = await runPass();
            onPassEnd?.(handled);
        } while (pending);
    };

    const trigger = () => {
        if (loop) {
            pending = true;
            return;
        }
        loop = runLoop()
            .catch(err => {
                console.error('Thumbnail job failed:', err);
                status = { ...status, state: 'failed' };
                pending = false;
            })
            .finally(() => {
                loop = null;
                // a trigger that arrived after the last pass checked `pending` still gets its pass
                if (pending) {
                    pending = false;
                    trigger();
                }
            });
    };

    return {
        trigger,
        status: () => ({ ...status }),
        whenIdle: async () => {
            while (loop) {
                await loop;
            }
        },
    };
}

export { createThumbnailJob, ThumbnailJob, ThumbnailJobOptions };
