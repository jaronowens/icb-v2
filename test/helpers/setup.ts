/**
 * Loaded by Mocha before any test file (see .mocharc.json).
 *
 * Startup sync logs every step, and the fixtures deliberately include files that log warnings,
 * so console.log/info/warn are silenced during tests. console.error still prints.
 * Run with TEST_LOGS=1 to see everything.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

if (!process.env.TEST_LOGS) {
    const noop = () => {};
    console.log = noop;
    console.info = noop;
    console.warn = noop;
}
