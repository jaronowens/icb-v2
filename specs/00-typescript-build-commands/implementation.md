# Implementation Plan: TypeScript Build Commands

Spec: [`spec.md`](./spec.md)

## Goal

Replace the manual "compile TS and overwrite the JS file" workflow with a build command. The command compiles the project into `/build`, mirroring the root directory structure. `npm start` then runs the server from `/build`.

## Decisions (confirmed with project owner)

| Topic | Decision |
|---|---|
| Command name | `npm run build`. `npm build` is not a valid npm command: npm 9.3.1 replies `Unknown command: "build"`. Custom scripts must go through `npm run`. |
| Contents of `/build` | **A full, runnable mirror** of the app: compiled TS, the plain JS files (`app.js`, `routes/`, `util/`, `bin/www`), and runtime assets (`views/`, `public/`, `directories.json`). |
| Existing compiled `.js` twins | **Deleted** from the source tree. The `.ts` files are the only source of truth. |
| Start flow | **`prestart` runs the build**, so `npm start` always runs fresh output. |
| Compile target | **ES2022 / CommonJS**. Output uses native `async/await` instead of the ES5 `__awaiter`/`__generator` helpers. |

## Current State (findings)

- `package.json` has only `"start": "node ./bin/www"`. `typescript@5.8.3` is installed (in `dependencies`) and `@types/node` is in `devDependencies`. There is **no `tsconfig.json`**.
- TS sources and their committed, hand-compiled twins:
  - `entity/localFileNode.ts` / `.js`
  - `entity/mediaNode.ts` / `.js`
  - `repository/local.ts` / `.js`
  - `repository/media.ts` / `.js`
  - `service/localFileService.ts` / `.js`
  - `service/mediaService.ts` / `.js`
- I verified that the committed twins are currently in sync with their `.ts` sources. A fresh default `tsc` compile differs only in line endings, so deleting them loses nothing.
- These files are plain JS with no TS source: `app.js`, `bin/www` (no extension), `routes/*.js`, `util/httpRequests.js`.
- Runtime path dependencies:
  - `app.js` uses `path.join(__dirname, 'views')` and `path.join(__dirname, 'public')`, so `views/` and `public/` must sit next to the built `app.js`.
  - `app.js` uses `require('./directories.json')`. tsc does **not** emit this JSON file, so it must be copied.
  - The DB paths (`./db/media.sqlite3` in `app.js` and `routes/*.js`) are relative to the **process cwd**, not `__dirname`. `npm start` runs from the project root, so the DB stays in root `/db`. No change is needed.
- `.gitignore` already contains `build`.
- Strict mode is **not** viable yet. `tsc --strict` fails on implicit `any` parameters (`db`, `fs`) and `unknown` catch variables (`err.message`). The config must use `strict: false`.

## Implementation Steps

### Step 1: Remove the compiled JS twins

Delete the six `.js` files listed above (`git rm`). This must happen **before** step 2. With `allowJs` enabled, a `foo.ts`/`foo.js` pair would both emit to `build/foo.js`, and tsc would fail with "Cannot write file ... would overwrite input file" (TS5055/TS5056).

### Step 2: Add `tsconfig.json` at the project root

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "rootDir": ".",
    "outDir": "build",
    "allowJs": true,
    "checkJs": false,
    "strict": false,
    "noEmitOnError": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": [
    "app.js",
    "entity/**/*",
    "repository/**/*",
    "service/**/*",
    "routes/**/*",
    "util/**/*"
  ]
}
```

Notes:
- `rootDir: "."` together with `outDir: "build"` keeps the directory structure: `service/mediaService.ts` becomes `build/service/mediaService.js`.
- `allowJs` makes tsc carry the plain JS files into `/build` with the same layout. `checkJs: false` keeps tsc from type-checking them.
- `noEmitOnError` keeps a type error from producing a partial build.
- The `include` list is explicit, so `node_modules`, `build`, `specs`, `scripts`, and `db` are never picked up.
- `module: "commonjs"` matches the existing `require`-based JS. The TS files use `export { ... }`, which compiles to `exports.x = ...`, so the current `const { x } = require(...)` calls keep working.

### Step 3: Add build helper scripts in `scripts/`

These scripts use only Node's `fs` module, so they need no new dependencies and work on Windows (`rm -rf` and `cp` do not work in `cmd`/PowerShell npm scripts).

**`scripts/clean.js`**: deletes `/build` so every build starts fresh. This meets the spec's requirement that existing compiled JS gets recompiled, and it removes stale output from deleted or renamed sources.

```js
const fs = require('fs');
const path = require('path');

fs.rmSync(path.join(__dirname, '..', 'build'), { recursive: true, force: true });
```

**`scripts/copy-assets.js`**: copies everything tsc does not emit.

```js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'build');

const assets = [
  'bin/www',          // no .js extension, so tsc ignores it
  'directories.json', // JSON is not emitted by tsc for require() in JS files
  'views',
  'public',
];

for (const asset of assets) {
  fs.cpSync(path.join(root, asset), path.join(out, asset), { recursive: true });
}
console.log(`Copied ${assets.length} assets to build/`);
```

`build/bin/www` keeps its `require('../app')`, which resolves to `build/app.js`. This is correct.

### Step 4: Update `package.json` scripts

```json
"scripts": {
  "clean": "node scripts/clean.js",
  "build": "npm run clean && tsc -p tsconfig.json && node scripts/copy-assets.js",
  "prestart": "npm run build",
  "start": "node ./build/bin/www"
}
```

- `&&` chaining works in npm scripts on Windows (cmd) as well as POSIX shells.
- If `tsc` fails, the chain stops. `prestart` then fails, so `npm start` never runs.
- `tsc` resolves to the local `node_modules/.bin/tsc`. Leave `typescript` in `dependencies`, not `devDependencies`, because `npm start` needs it through `prestart`. Moving it would break `npm install --omit=dev` setups.

### Step 5: Update `README.md`

- **Usage and available scripts**: document `npm run build` (clean, compile, and copy into `/build`) and `npm start` (builds, then runs `build/bin/www`). Mention `npm run clean`.
- **"Use of both Javascript and Typescript"**: rewrite this section. Compiled JS no longer lives next to the sources. Edit `.ts` files and the plain `.js` files (`app.js`, `routes/`, `util/`) in the source tree, and never edit `/build`. Add that `directories.json`, `views/`, and `public/` are copied at build time, so changes to them take effect on the next `npm start`.

## Verification

1. **Clean build**: delete `/build` and run `npm run build`. The command should exit 0, and `build/` should contain:
   ```
   build/app.js
   build/bin/www
   build/directories.json
   build/entity/{localFileNode,mediaNode}.js
   build/repository/{local,media}.js
   build/routes/{collection,external,index,local,media,users}.js
   build/service/{localFileService,mediaService}.js
   build/util/httpRequests.js
   build/views/*.pug
   build/public/stylesheets/style.css
   ```
   There should be no `.ts` files in `build/`, and no `.js` twins should be left in `entity/`, `repository/`, or `service/`.
2. **Rebuild overwrites**: edit a log string in a `.ts` file, run `npm run build`, and confirm the change appears in the matching `build/**/*.js`. Create a stray `build/junk.js`, rebuild, and confirm it is gone.
3. **Failing build blocks start**: add a deliberate type error to a `.ts` file (for example `const x: number = 'a';`). `npm run build` should fail, `build/` should be empty or missing, and `npm start` should not start the server. Revert the error.
4. **Runtime**: run `npm start`. The server should index the configured directories, and `GET /` should return 200, `GET /media` should return JSON media nodes, `GET /local` should return rows, and `GET /<directory-name>/<file>` should serve the file.
5. **Pug and static paths**: check that `GET /` renders `index.pug` and that `/stylesheets/style.css` is served. Both confirm the `__dirname`-relative paths resolve inside `build/`.

**Pre-check already done:** I applied this config to a scratch copy of the repo with the twins removed. tsc exited 0 and produced exactly the compiled tree above, without `directories.json`, which confirms the copy step is needed. With the assets copied, `node build/bin/www` started, indexed 670 local files, and answered `GET /` (200) and `GET /media` (JSON).

## Files Changed

| File | Change |
|---|---|
| `entity/*.js`, `repository/*.js`, `service/*.js` | Deleted (6 files) |
| `tsconfig.json` | New |
| `scripts/clean.js` | New |
| `scripts/copy-assets.js` | New |
| `package.json` | `clean`, `build`, `prestart` scripts added; `start` now points to `./build/bin/www` |
| `README.md` | Scripts and JS/TS sections updated |

## Out of Scope / Follow-ups

- **Watch mode / dev loop**: a `dev` script (for example `tsc --watch` plus `node --watch build/bin/www`) would help but isn't part of the spec.
- **Strict typing**: turning on `strict` needs types for `db`/`fs` parameters and narrowing of `catch (err)`. That should be its own task.
- **Converting `app.js` and `routes/` to TS**: possible later. The `allowJs` setup lets files migrate one at a time.
- **Existing bug, unrelated to this work**: `routes/media.js` imports `getLocalMedia` from `repository/media`, which doesn't export it (`getMedia` exists). The import is `undefined` but unused, so it has no effect on the build.
