# Implementation Plan: Convert to TypeScript

Spec: [`spec.md`](./spec.md)

## Goal

Convert the last JavaScript source files to TypeScript and use `import`/`export` everywhere. Once that's done, `/build` holds only compiled TypeScript and the static assets, and the tests no longer need the CommonJS workarounds they use for `app.js`.

## Decisions (confirmed with project owner)

| Topic | Decision |
|---|---|
| "ESM format" | **ESM syntax, CommonJS output.** Source files use `import`/`export`, like `entity/`, `repository/` and `service/` already do. `tsconfig.json` keeps `module: "commonjs"`, so the runtime, `__dirname`, and `tsx/cjs` in Mocha all stay as they are. There's no `"type": "module"` and no `.js` extensions on imports. |
| `bin/www` | **Converted to `bin/www.ts`.** It compiles to `build/bin/www.js`, which `npm start` runs. It's no longer copied as an asset. |
| `routes/users.js` | **Deleted.** It isn't mounted in `app.js` and nothing imports it. It's leftover express-generator boilerplate. |
| `util/httpRequests.js` | **Converted, behavior unchanged.** Nothing uses it yet, but it's kept for the planned `/external` work. |
| Strictness | **`strict: false` stays on.** Handlers get Express types where that's cheap. Turning on strict mode is still its own task. |

## Current State (findings)

- Plain JS that uses `require()`: `app.js`, `bin/www`, `routes/{collection,external,index,media,users}.js`, `util/httpRequests.js`.
- `routes/media.js` has an uncommitted change in the working tree: it drops the unused `getLocalMedia` import and shortens the POST stub text. The conversion starts from that version, so commit or keep that change first.
- `tsconfig.json` has `allowJs: true` / `checkJs: false` only so it can carry the JS files into `/build`, and its `include` lists `app.js`.
- `esModuleInterop` is **off**. Because of that, the tests use two workarounds:
  - `test/integration/media.test.ts`: `import request = require('supertest')`.
  - `test/helpers/index.ts`: `const { createApp } = require('../../app')`, because `app.js` has no types.
- `scripts/copy-assets.js` copies `bin/www` (tsc skips it because it has no extension) and `directories.json`, plus `views/` and `public/`.
- `.mocharc.json` matches `test/**/*.test.{js,ts}`.
- `@types/*` aren't installed for any runtime dependency (express, cors, morgan, cookie-parser, http-errors, debug). Under `strict: false`, an import with no types is just `any`. It compiles, but you get no checking.
- `Directory` (`{ name, path }`) is declared in `service/startupService.ts` but not exported.

## Implementation Steps

### Step 1: Add type packages (devDependencies)

```
npm i -D @types/express@^5 @types/cors @types/morgan @types/cookie-parser @types/http-errors @types/debug
```

They go in `devDependencies`, next to `@types/node`. `@types/express@5` matches Express 5, including its `{*splat}` route syntax and async handlers. The installed `http-errors` (1.6) and `debug` (2.6) are older than their newest `@types`, but `createError(404)` and `debug('ns')` haven't changed.

### Step 2: Update `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "rootDir": ".",
    "outDir": "build",
    "strict": false,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmitOnError": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": [
    "app.ts",
    "bin/**/*",
    "entity/**/*",
    "repository/**/*",
    "service/**/*",
    "routes/**/*",
    "util/**/*"
  ]
}
```

- `allowJs` and `checkJs` are removed. No JS source is left in `include`, and if a stray `.js` file shows up there later, it won't end up in `/build` without anyone noticing.
- `esModuleInterop` allows default imports of CommonJS packages (`import express from 'express'`). Existing `import * as fs from 'node:fs'` style imports still work, because they now go through `__importStar`.
- `resolveJsonModule` lets `bin/www.ts` import `directories.json`. tsc then writes it to `build/directories.json` on its own, so it's dropped from `copy-assets`.

### Step 3: Convert `app.js` to `app.ts`

- `require` becomes `import`: `createError from 'http-errors'`, `express from 'express'`, `* as path from 'node:path'`, `cookieParser`, `logger from 'morgan'`, `cors`, the four routers as default imports, and `{ isValidDirectoryName, Directory }` from `./service/startupService`.
- `module.exports = { createApp }` becomes `export { createApp }`.
- Type the argument as `{ db: Database | Promise<Database>; directories: Directory[] }`, using `Database` from `sqlite`. Export `Directory` from `startupService.ts` (one-line change).
- The error handler becomes `(err: HttpError, req: Request, res: Response, next: NextFunction) => …`. **It keeps all four parameters**, because Express only treats a 4-argument function as an error handler. `next` is unused, so note that in a comment.
- `path.join(__dirname, 'views' | 'public')` stays unchanged. With CommonJS output, `__dirname` is `build/`, which is where `views/` and `public/` get copied.
- `git mv app.js app.ts`, so git shows the conversion as a rename.

### Step 4: Convert `routes/`

For each of `collection`, `external`, `index` and `media`:
- `git mv x.js x.ts`.
- Use `import { Router } from 'express'` and `const router = Router();`, and end with `export default router;`.
- Leave the handlers as they are. Unused `next` parameters can be removed, but the status codes and response text **don't change**, because the stub behavior is out of scope.
- `media.ts` imports `{ getMediaNodes }` from `../service/mediaService`. The `GET /` handler stays `async`.

Delete `routes/users.js` (`git rm`).

### Step 5: Convert `util/httpRequests.js` to `util/httpRequests.ts`

- Use named exports: `export { getFromAPI, postToAPI, updateToAPI, deleteFromAPI }`.
- Type the parameters as `endpoint: string` and `data: unknown`. Return types match what the code already returns: `Promise<any>` for `getFromAPI` (parsed JSON), and `Promise<Response | undefined>` for the others.
- Swap the JSDoc `{*}` types for the TS types and keep the descriptions.
- **Behavior is unchanged.** These existing quirks stay, and are listed under Follow-ups: a non-OK response resolves to `undefined` instead of throwing, `postToAPI`'s error message says "GET", and the original error is thrown away.

### Step 6: Convert `bin/www` to `bin/www.ts`

- `git mv bin/www bin/www.ts`. Keep the `#!/usr/bin/env node` line, which tsc preserves.
- `var` becomes `const`, and `require` becomes `import`:
  - `{ createApp } from '../app'`, `{ startup } from '../service/startupService'`
  - `directories from '../directories.json'`
  - `createDebug from 'debug'`, then `const debug = createDebug('icb-v2:server')`
  - `* as http from 'node:http'`, `sqlite3 from 'sqlite3'` (`sqlite3.verbose()`), `{ open } from 'sqlite'`
- Add types: `normalizePort(val: string): number | string | false`, `onError(error: NodeJS.ErrnoException)`. In `onListening`, `server.address()` can return `string | AddressInfo | null`, so check for a string first, as the code does now.
- Startup order is the same: open the DB, `createApp`, start `startup()` without awaiting it, then listen.

### Step 7: Update the build scripts

`scripts/copy-assets.js`: the list is now just `views` and `public`. Remove the comments about `bin/www` and `directories.json`.

`package.json`:
```json
"start": "node ./build/bin/www.js"
```
`build`, `clean` and `prestart` don't change.

`scripts/*.js` **stay as plain CommonJS JS**. They're build tooling that Node runs directly, before anything is compiled, and they aren't part of the app.

### Step 8: Simplify the tests

These changes are small, so they're done here, as the spec allows:
- `test/helpers/index.ts`: replace `const { createApp } = require('../../app')` with `import { createApp } from '../../app'`. `createTestApp` now gets type-checked against the real `createApp` signature.
- `test/integration/media.test.ts`: replace `import request = require('supertest')` and its comment with `import request from 'supertest'`. `test/tsconfig.json` extends the root config, so it gets `esModuleInterop` from there.
- `.mocharc.json`: change `spec` to `test/**/*.test.ts`. Keep `require: ["tsx/cjs", …]`, because CommonJS output means the CJS hook is still the right one.
- No changes to Mocha/Supertest themselves. With every file in TS, the main remaining reason to pick Mocha over Vitest or `node --test` is gone, but changing runners would be a larger change than this spec covers. That's listed under Follow-ups.

### Step 9: Update `README.md`

- **"Use of Javascript and Typescript"**: rewrite it as "Typescript". All app source is TS and compiles to `/build`. Only `scripts/` is plain JS. Keep the paragraph about never editing `/build`, and say that `views/` and `public/` are copied and `directories.json` is emitted at build time.
- **`npm run build`**: remove "(and the plain Javascript files)" and the copied `bin/www` / `directories.json`.
- **`npm start`**: it now runs `build/bin/www.js`.
- **Testing**: name test files `<module>.test.ts`, and remove "(or `.js`)".

## Verification

1. **Baseline before any change**: on the current commit, run `npm start`, wait for `Database ready`, then save `curl -s localhost:3000/media > before.json` (put it in the scratchpad, not the repo). Also save the status and body of `GET /`, `GET /collection`, `GET /external/foo` and `GET /nope` (the 404 page).
2. **Nothing JS or `require` left**: `git ls-files '*.js'` lists only `scripts/*.js` and `specs/near-match-duplicates/tools/*.js`. `grep -rn "require(" app.ts bin routes util test` finds nothing.
3. **Clean build**: `npm run build` exits 0, and `build/` contains `app.js`, `bin/www.js`, `directories.json`, `routes/{collection,external,index,media}.js`, `util/httpRequests.js`, the entity/repository/service output, `views/` and `public/`. No `users.js`, no `.ts` files, and no extensionless `bin/www`.
4. **Type errors block the build**: add `const x: number = 'a';` to `routes/media.ts`, check that `npm run build` fails, then revert. This confirms the converted files are type-checked now, where before they were only carried through.
5. **Acceptance: startup**: `npm start` logs the same sync steps and `Database ready`.
6. **Acceptance: `/media`**: save `curl -s localhost:3000/media > after.json`, and `diff before.json after.json` prints nothing. The other baseline routes give the same status and body as before.
7. **Tests**: `npm test` passes, and `npx tsc -p test` exits 0.

## Files Changed

| File | Change |
|---|---|
| `app.js` → `app.ts` | Converted |
| `bin/www` → `bin/www.ts` | Converted |
| `routes/{collection,external,index,media}.js` → `.ts` | Converted |
| `routes/users.js` | Deleted |
| `util/httpRequests.js` → `.ts` | Converted |
| `service/startupService.ts` | Export `Directory` |
| `tsconfig.json` | Drop `allowJs`/`checkJs`, add `esModuleInterop` and `resolveJsonModule`, update `include` |
| `scripts/copy-assets.js` | Copy only `views` and `public` |
| `package.json` | `start` → `build/bin/www.js`; new `@types/*` devDependencies |
| `test/helpers/index.ts`, `test/integration/media.test.ts` | Use `import` |
| `.mocharc.json` | Spec glob matches `.ts` only |
| `README.md` | TS/JS section, commands, testing note |

## Risks

- **`esModuleInterop` changes the compiled output of existing files.** Namespace imports like `import * as fs` now go through `__importStar`. `startupService` passes `fs` into `syncDirectory`, and the wrapped object still exposes the same functions through getters. The startup unit test covers this path, so check that it passes after Step 2, before converting anything.
- **`@types/express@5` may reject some handler shapes.** For example, it may complain when an async handler's return value is used. Under `strict: false` this should be rare. If it does happen, fix the types and don't change the behavior.

## Out of Scope / Follow-ups

- Everything already listed in the spec: readiness, JSON errors, and the stub routes (`specs/media-route/`).
- **`util/httpRequests.ts` quirks**: it swallows non-OK responses, the POST error message is wrong, and the original error is lost. This is worth fixing when `/external` starts using it.
- **Strict mode**: now that every file is TS, `strict: true` is the next step. It needs typed `db` parameters and narrowed `catch` variables.
- **Test runner**: with no mixed JS/TS tree left, it's worth comparing Vitest or `node --test` with Mocha + tsx at some point.
- **`scripts/`** stays CommonJS JS on purpose.
