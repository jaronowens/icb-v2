## Overview
Every feature so far has been checked by hand: start the server, wait for sync, call an endpoint, and look at the database. This is slow, easy to get wrong, and gets worse with each feature. This spec adds an automated test suite, so acceptance criteria can be written as tests and re-run on every change.

The suite uses [Mocha](https://mochajs.org/) as the test runner, [Supertest](https://www.npmjs.com/package/supertest) for HTTP requests against the Express app, `node:assert` for assertions, and [tsx](https://www.npmjs.com/package/tsx) so tests can load the `.ts` source directly without building first.

## Why these tools
- **Supertest** takes the exported `app` and sends it requests without opening a port. `app.js` already exports the app without calling `listen()`, which happens in `bin/www`.
- **Mocha + tsx** fits the mixed JS/TS tree. `app.js` and `routes/*.js` `require()` `.ts` files with no extension (for example `require('./repository/schema')`). The `tsx` require hook resolves those, so tests run against the source, not `/build`. Vitest's transforms don't cover raw `require()`, and Node's built-in type stripping doesn't resolve extensionless CommonJS requires.
- **`node:assert`** is built in, so there's no assertion library to learn. Chai or Sinon can be added later if they're needed.
- `tsx` doesn't type-check. That's fine, because `npm run build` already fails on type errors.

## Problems
- **Importing `app.js` has side effects.** Just requiring it opens the real `./db/media.sqlite3`, runs migrations, and syncs (and hashes) every folder in `directories.json`. A test that imports the app would change the real database and scan real image folders, which makes it slow and unpredictable.
- **The database path and directory list are hard-coded.** Tests can't point the app at an in-memory database or at a fixtures folder.
- **Startup sync can't be awaited.** The sync chain is started inside `app.js` and nothing outside it can tell when it's finished. Tests (and the readiness work in `specs/media-route/`) need to control or await it.
- **`BASE_URL` in `localFileService.ts` is hard-coded** to `http://localhost:3000`. This doesn't block testing, but tests that check `imageURL` will depend on that value.

## Spec

### App factory
- `app.js` exports a `createApp({ db, directories })` function instead of an app built at import time. Requiring `app.js` has no side effects.
  - `db` is the promise for an open `sqlite` connection, stored in `app.locals.db` as it is now.
  - `directories` is the list of `{ name, path }` entries. Name validation (`VALID_DIRECTORY_NAME`) and the static routes for each directory stay in `createApp`.
- Startup sync (migrate, `syncDirectory` for each directory, then the Media steps, ending with `Database ready`) moves into a `startup(db, directories)` function, exported from its own module (for example `service/startupService.ts`). It returns a promise that resolves when sync finishes and rejects if it fails, so callers can await it.
- `bin/www` opens the real database, reads `directories.json`, calls `createApp`, starts `startup` without awaiting it (so the server listens while sync runs, as it does now), and logs startup failures as it does now.
- `npm start` behaves exactly as before.

### Test setup
- Add `mocha`, `supertest`, `@types/mocha`, `@types/supertest` and `tsx` as dev dependencies.
- Add a `.mocharc.json` that loads `tsx` (`"require": ["tsx/cjs"]`, or whatever `tsx` version in use documents for CommonJS), and picks up `test/**/*.test.{js,ts}`. Spec files are matched recursively.
- Add `npm test`, which runs Mocha. It doesn't run `npm run build` first.
- Add a `test/helpers/` module with:
  - `createTestDb()`: opens an in-memory SQLite database (`:memory:`) and runs `migrate` on it. Each test or suite gets a fresh one.
  - `createTestApp(options)`: calls `createApp` with a test database and a fixtures directory list. It can optionally run `startup` and wait for it.
- Add `test/fixtures/` with a few small images that are committed to the repo: two copies of the same image (to check duplicate merging), a resized copy of it (to check near-duplicate hashing), a different image, and a file that `image-size` can't read. Keep the whole folder under about 100 KB.
- Tests never touch `./db/media.sqlite3` or the folders in `directories.json`.

### Layout
- `test/unit/` for repository and service functions, called directly with a test database. These already take `db` (and `fs` for `syncDirectory`) as arguments, so they need no refactoring.
- `test/integration/` for Supertest requests against `createTestApp`.
- Test files are named `<module>.test.js` or `<module>.test.ts`, after the module they cover.

### Starter tests
These show the patterns for later specs to copy. They aren't meant to cover the whole codebase.
- **Unit:** `migrate` on an empty database ends at `CURRENT_VERSION`, and running it again changes nothing.
- **Unit:** after `startup` on the fixtures, duplicate files share one Media row, and the unreadable file has `NULL` width and height (the Local Media Data acceptance criteria).
- **Integration:** `GET /media` after startup returns one entry per distinct fixture image, with the real `width` and `height`.

### README
- Document `npm test` under Available Commands.
- Add a short "Testing" section covering where tests go, the helpers, and that tests use an in-memory database and `test/fixtures/`.
- Mark Testing Framework as implemented in Planned Features and link this spec.

## Out of scope
- Tests for the media-route changes. They're written as part of that spec, using this framework.
- Coverage reports, CI, and watch mode. Any of them can be added later with a few lines of config.
- Making `BASE_URL` configurable. Tests that check `imageURL` assert against the current value.
- Mocking libraries such as Sinon. `syncDirectory` already takes `fs`, and an in-memory database removes most of the need for mocks.
- Converting `app.js`, `routes/` or `util/` to TypeScript.

## Acceptance
- `npm test` runs the starter tests and they pass, from a clean checkout after `npm install`, without running `npm run build`.
- Running `npm test` doesn't create, change or read `./db/media.sqlite3`, and doesn't read any folder in `directories.json`. You can check this by comparing the file's modified time before and after.
- Requiring `app.js` in a Node REPL opens no database and logs nothing.
- `npm start` still builds, syncs, logs `Database ready`, and serves `GET /media` with the same response as before.
- A deliberately broken assertion makes `npm test` fail with a non-zero exit code and a readable failure message.
- `npm run build` still succeeds, and test files aren't compiled into `/build`. They're outside the `include` list in `tsconfig.json`.
