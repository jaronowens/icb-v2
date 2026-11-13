/* One queue per connection: SQLite has no nested transactions, and every request shares one connection. */
const queues = new WeakMap<object, Promise<unknown>>();

/**
 * Runs `fn` inside BEGIN ... COMMIT, rolling back if it throws.
 * Calls on the same connection wait for each other, so concurrent requests never nest a BEGIN.
 * Startup sync opens its own transactions and isn't queued here; /media is gated until it has finished.
 */
const withTransaction = <T>(db, fn: () => Promise<T>): Promise<T> => {
    const previous = queues.get(db) ?? Promise.resolve();
    const run = previous.then(async () => {
        await db.run('BEGIN');
        try {
            const result = await fn();
            await db.run('COMMIT');
            return result;
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
    });
    // the next caller waits for this one to finish, whether it succeeded or not
    queues.set(db, run.catch(() => {}));
    return run;
};

export { withTransaction };
