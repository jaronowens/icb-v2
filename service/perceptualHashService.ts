import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
// sharp is loaded here before any worker starts: its docs ask for that on some platforms, so its native library
// stays loaded while workers come and go. The main thread doesn't use it otherwise.
import 'sharp';
import { getMediaNeedingPerceptualHash, setPerceptualHashes } from '../repository/media';
import { withTransaction } from '../util/transaction';
import { PERCEPTUAL_TYPES, PHASH_PREFIX, UNHASHABLE } from './perceptualHashSettings';
import { HashRequest, HashResponse } from './perceptualHashWorker';

type PerceptualHashState = 'idle' | 'running' | 'failed';
type PerceptualHashStatus = { state: PerceptualHashState, done: number, total: number };
const IDLE_STATUS: PerceptualHashStatus = { state: 'idle', done: 0, total: 0 };

type PerceptualHashJob = {
    /* Starts a pass, or queues one more if a pass is running. */
    trigger(): void;
    status(): PerceptualHashStatus;
    /* Resolves when no pass is running or queued. */
    whenIdle(): Promise<void>;
};

type JobOptions = {
    workers?: number,
    /* Called after each pass, with the number of Media rows it handled. For tests. */
    onPassEnd?: (handled: number) => void,
};

/* Results are written in batches, so stopping mid-pass loses at most one batch. */
const BATCH_SIZE: number = 50;
const PROGRESS_INTERVAL: number = 100;
/* Workers that crash before replying even once. After this many in one pass, the pass fails instead of retrying forever. */
const MAX_STARTUP_FAILURES: number = 3;

/*
 * Workers share the process's libuv threadpool (UV_THREADPOOL_SIZE, 4 by default) with the main thread: sharp decodes
 * and file reads run on it in every worker, and so does every sqlite3 query. Using every pool thread for hashing leaves
 * requests and result writes queued behind decodes, so one thread is always left free. On highly-rated (670 images),
 * 3 workers kept query latency at idle levels (p95 3 ms) for a 9 s pass; 15 workers only cut the pass to 6.8 s, while
 * the median query took 32 ms and hundreds of results waited unsaved. See implementation.md.
 */
const defaultWorkerCount = (): number => {
    const threadpoolSize = Number(process.env.UV_THREADPOOL_SIZE) || 4;
    return Math.max(1, Math.min(os.availableParallelism() - 1, threadpoolSize - 1));
}

/* The worker count from PERCEPTUAL_HASH_WORKERS, or the default if it's unset or not a positive integer. */
const workerCountFromEnv = (env = process.env): number => {
    const value = Number(env.PERCEPTUAL_HASH_WORKERS);
    return Number.isInteger(value) && value > 0 ? value : defaultWorkerCount();
}

/* Compiled code runs the compiled worker. Under tsx (tests), the worker is .ts and needs tsx registered in its own thread. */
const spawnWorker = (): Worker => {
    const isSource = __filename.endsWith('.ts');
    const workerFile = path.join(__dirname, `perceptualHashWorker.${isSource ? 'ts' : 'js'}`);
    return new Worker(workerFile, isSource ? { execArgv: ['--require', 'tsx/cjs'] } : {});
}

/**
 * Hashes `requests` on a pool of `size` workers, one request per worker at a time, and calls `onResponse` for each.
 * A worker that crashes mid-request reports that request as a read failure and is replaced.
 * Every worker is terminated before this settles. Rejects if workers keep failing to start.
 */
const runPool = (requests: HashRequest[], size: number, onResponse: (response: HashResponse) => void): Promise<void> => {
    return new Promise((resolve, reject) => {
        let next = 0;
        let startupFailures = 0;
        let settled = false;
        const workers = new Set<Worker>();

        const finishIfDone = () => {
            if (workers.size === 0 && !settled) {
                settled = true;
                resolve();
            }
        };
        const abort = (err: Error) => {
            settled = true;
            for (const worker of workers) {
                worker.terminate();
            }
            workers.clear();
            reject(err);
        };

        const start = () => {
            const worker = spawnWorker();
            workers.add(worker);
            let current: HashRequest | null = null;
            let replied = false;
            let finished = false;

            const retire = () => {
                finished = true;
                workers.delete(worker);
                worker.terminate();
                finishIfDone();
            };
            const feed = () => {
                if (settled || next >= requests.length) {
                    return retire();
                }
                current = requests[next++];
                worker.postMessage(current);
            };
            const crash = (err: Error) => {
                if (finished || settled) {
                    return;
                }
                finished = true;
                workers.delete(worker);
                worker.terminate();
                if (current) {
                    onResponse({ id: current.id, error: 'read', message: `worker crashed: ${err.message}` });
                    current = null;
                }
                if (!replied && ++startupFailures >= MAX_STARTUP_FAILURES) {
                    return abort(new Error(`Perceptual hash workers keep failing to start: ${err.message}`));
                }
                if (next < requests.length) {
                    start();
                }
                finishIfDone();
            };

            worker.on('message', (response: HashResponse) => {
                replied = true;
                current = null;
                onResponse(response);
                feed();
            });
            worker.on('error', crash);
            worker.on('exit', code => crash(new Error(`exited with code ${code}`)));
            feed();
        };

        for (let i = 0; i < size; i++) {
            start();
        }
    });
}

/**
 * The background job that fills Media.perceptualHash (specs/07-background-perceptual-hash).
 * Each pass hashes the mounted Media rows that need it on a fresh pool of worker threads, so decoding never blocks
 * requests, and terminates the pool when it's done. `db` may be the connection or the promise for one.
 */
const createPerceptualHashJob = (db, { workers = defaultWorkerCount(), onPassEnd }: JobOptions = {}): PerceptualHashJob => {
    let status: PerceptualHashStatus = { ...IDLE_STATUS };
    let pending = false;
    let loop: Promise<void> | null = null;

    /* Hashes everything that needs it. Returns the number of Media rows handled. */
    const runPass = async (): Promise<number> => {
        const connection = await db;
        const requests: HashRequest[] = await getMediaNeedingPerceptualHash(connection, PERCEPTUAL_TYPES, PHASH_PREFIX, UNHASHABLE);
        if (requests.length === 0) {
            status = { ...IDLE_STATUS };
            return 0;
        }
        status = { state: 'running', done: 0, total: requests.length };
        console.log(`Perceptual hashing ${requests.length} media`);

        const sources = new Map(requests.map(request => [request.id, request.source]));
        let batch: { id: number, value: string }[] = [];
        // writes are chained so they happen in order, and the pass waits for the last one
        let writes: Promise<void> = Promise.resolve();
        const flush = () => {
            if (batch.length === 0) {
                return;
            }
            const results = batch;
            batch = [];
            writes = writes.then(() => withTransaction(connection, () => setPerceptualHashes(connection, results)));
        };

        await runPool(requests, Math.min(workers, requests.length), response => {
            if ('hash' in response) {
                batch.push({ id: response.id, value: `${PHASH_PREFIX}${response.hash}` });
            } else if (response.error === 'decode') {
                console.warn(`Could not decode ${sources.get(response.id)}, marking it unhashable: ${response.message}`);
                batch.push({ id: response.id, value: UNHASHABLE });
            } else {
                // left NULL, so the next pass tries again
                console.warn(`Could not read ${sources.get(response.id)}, will retry next pass: ${response.message}`);
            }
            status.done++;
            if (batch.length >= BATCH_SIZE) {
                flush();
            }
            if (status.done % PROGRESS_INTERVAL === 0 || status.done === status.total) {
                console.log(`Perceptual hashed ${status.done}/${status.total} media`);
            }
        });
        flush();
        await writes;
        status = { ...status, state: 'idle' };
        return requests.length;
    };

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
                console.error('Perceptual hashing failed:', err);
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

export { createPerceptualHashJob, workerCountFromEnv, IDLE_STATUS, PerceptualHashJob, PerceptualHashStatus };
