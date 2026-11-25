import * as assert from 'node:assert/strict';
import { createLimiter } from '../../util/limiter';
import { deferred } from '../helpers';

/* Lets queued promise callbacks run, so tasks the limiter has started have actually begun. */
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('createLimiter', () => {
    it('never runs more than `concurrency` tasks at once', async () => {
        const limiter = createLimiter(2);
        let running = 0, peak = 0;
        const task = async () => {
            running++;
            peak = Math.max(peak, running);
            await settle();
            running--;
        };
        await Promise.all(Array.from({ length: 10 }, (_, i) => limiter.run(task, i % 2 ? 'request' : 'background')));
        assert.equal(peak, 2);
        assert.equal(limiter.active(), 0);
        assert.equal(limiter.queued(), 0);
    });

    it('starts request tasks queued after background tasks first, and keeps FIFO order within a priority', async () => {
        const limiter = createLimiter(1);
        const order: string[] = [];
        const blocker = deferred();
        const first = limiter.run(() => blocker.promise, 'background');
        const record = (name: string) => async () => { order.push(name); };
        const tasks = [
            limiter.run(record('background 1'), 'background'),
            limiter.run(record('background 2'), 'background'),
            limiter.run(record('request 1'), 'request'),
            limiter.run(record('request 2'), 'request'),
        ];
        await settle();
        assert.equal(limiter.active(), 1);
        assert.equal(limiter.queued(), 4);
        assert.deepEqual(order, [], 'nothing starts while the slot is taken');

        blocker.resolve();
        await Promise.all([first, ...tasks]);
        assert.deepEqual(order, ['request 1', 'request 2', 'background 1', 'background 2']);
    });

    it('passes results and rejections through, and a rejected task frees its slot', async () => {
        const limiter = createLimiter(1);
        const failed = limiter.run(async () => { throw new Error('boom'); }, 'request');
        // a synchronous throw is a rejection too
        const thrown = limiter.run(() => { throw new Error('sync boom'); }, 'request');
        const after = limiter.run(async () => 42, 'background');
        await assert.rejects(failed, /boom/);
        await assert.rejects(thrown, /sync boom/);
        assert.equal(await after, 42);
        assert.equal(limiter.active(), 0);
    });

    it('rejects a concurrency that isn\'t a positive integer', () => {
        assert.throws(() => createLimiter(0));
        assert.throws(() => createLimiter(1.5));
    });
});
