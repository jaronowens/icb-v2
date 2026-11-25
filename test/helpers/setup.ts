/**
 * Loaded by Mocha before any test file (see .mocharc.json).
 *
 * Startup sync logs every step, and the fixtures deliberately include files that log warnings,
 * so console.log/info/warn are silenced during tests. console.error still prints.
 * Run with TEST_LOGS=1 to see everything.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { rm } from 'node:fs/promises';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

if (!process.env.TEST_LOGS) {
    const noop = () => {};
    console.log = noop;
    console.info = noop;
    console.warn = noop;
}

/* Root hook: deletes the thumbnail caches that createTestApp made (see testThumbnailDir in helpers/index.ts) once the run ends. */
export const mochaHooks = {
    afterAll: async () => {
        await rm(path.join(os.tmpdir(), `icb-test-${process.pid}`), { recursive: true, force: true });
    },
};
