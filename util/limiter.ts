type Priority = 'request' | 'background';

type Limiter = {
    /* Runs `fn` once a slot is free. Settles the same way `fn` does. */
    run<T>(fn: () => Promise<T>, priority: Priority): Promise<T>;
    /* Tasks running now. */
    active(): number;
    /* Tasks waiting for a slot. */
    queued(): number;
};

/**
 * Runs at most `concurrency` tasks at once. Waiting tasks sit in two FIFO queues, and a free slot always takes from
 * `request` before `background`, so work someone is waiting on jumps ahead of background work. A task that throws or
 * rejects still frees its slot. Queued tasks can't be cancelled or reprioritized.
 */
const createLimiter = (concurrency: number): Limiter => {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`Limiter concurrency must be a positive integer, got ${concurrency}`);
    }
    const queues: Record<Priority, (() => void)[]> = { request: [], background: [] };
    let running = 0;

    const next = () => {
        while (running < concurrency) {
            const start = queues.request.shift() ?? queues.background.shift();
            if (!start) {
                return;
            }
            running++;
            start();
        }
    };

    /* Frees a slot and starts the next task, before the finished task's caller hears back, so active() is accurate then. */
    const release = () => {
        running--;
        next();
    };

    const run = <T>(fn: () => Promise<T>, priority: Priority): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            queues[priority].push(() => {
                // the promise chain catches a synchronous throw from fn too
                Promise.resolve()
                    .then(fn)
                    .then(
                        value => { release(); resolve(value); },
                        err => { release(); reject(err); },
                    );
            });
            next();
        });
    };

    return {
        run,
        active: () => running,
        queued: () => queues.request.length + queues.background.length,
    };
}

export { createLimiter, Limiter, Priority };
