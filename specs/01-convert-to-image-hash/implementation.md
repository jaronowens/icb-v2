# Implementation Plan: Convert comparisons from imageURL to image hash

Scope: the **"imageURL is being used as the source of truth"** section of `spec.md`. Persisting data between server starts is out of scope: both tables are still dropped and recreated on startup. A few notes below point out where this work makes the persistence work easier later.

## Decisions (confirmed)

| Topic | Decision |
| --- | --- |
| Hash algorithm | Perceptual hash from `image-hash` (`bits = 16`, `precise = true`, giving a 256-bit hash). 8 bits was tried and reverted: on 30 real photos at half size and JPEG quality 60, 8 bits matched 27/30 resized copies against 19/30 at 16 bits. But on a folder of 39 images in 13 alternate-version sets (19 alternate pairs), 8 bits wrongly merged 8 pairs and 16 bits merged none. A missed duplicate just stays as its own Media row; a wrong merge makes alternates share tags. So 16 bits it is. |
| Unsupported types (gif, mp4, webm) | SHA-256 of the raw file bytes (Node `crypto`). Detects exact copies only. |
| Storage format | One `imageHash TEXT` column with a prefix, so the two kinds can never collide: `phash:<hex>` or `sha256:<hex>`. |
| Duplicates | Each **distinct hash gets one Media row**. Every Local file with that hash links to it through `Local.mediaID`. |
| `synchronizeFromMedia()` in the spec | Read as `synchronizeMedia()` in `repository/media.ts`, since no function called `synchronizeFromMedia` exists. |
| `/media` response | One entry per Media row (deduplicated). The URLs come from one representative Local file (the lowest `Local.rowid`). *This is easy to change to "one entry per file" if you'd rather have that.* |

## Prerequisite: Node version

`image-hash@8` is ESM-only and declares `engines.node >= 22.12`. In this project's shell, `node -v` prints **v18.14.0**, so the Volta pin (`23.11.0`) isn't active. On Node 18, `require('image-hash')` fails with `ERR_REQUIRE_ESM`.

- Run `volta install node@23.11.0`, or make sure Volta's shim comes before any other Node on `PATH`. Confirm that `node -v` prints `v23.11.0` inside the project directory.
- With Node ≥ 22.12, `require()` of an ES module is supported without a flag. A normal `import { imageHash } from 'image-hash'` in a `.ts` file compiles (with `module: commonjs`) to `require('image-hash')` and works. No tsconfig changes are needed.
  - Fallback if that turns out to be a problem: keep the import type-only and load the module through a non-transpiled dynamic import (`new Function('s', 'return import(s)')`). Use this only if needed.
- Optional: add `"engines": { "node": ">=22.12" }` to `package.json` so a wrong Node fails loudly.

---

## Step 1: Entities

**`entity/localFileNode.ts`**: add `imageHash: string;`.

**`entity/mediaNode.ts`**: add `imageHash: string;`.

## Step 2: New hashing helper (`service/hashService.ts`)

A new TypeScript module, so the hashing logic has one home that is easy to test.

```ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { imageHash } from 'image-hash';

const PERCEPTUAL_TYPES = ['jpg', 'jpeg', 'png', 'webp'];
const HASH_BITS = 16;

const sha256File = (filePath: string): Promise<string> => /* stream the file into createHash('sha256'), resolve hex */;

const computeFileHash = async (filePath: string, extension: string): Promise<string> => {
    if (PERCEPTUAL_TYPES.includes(extension.toLowerCase())) {
        try {
            return `phash:${await imageHash(filePath, HASH_BITS, true)}`;
        } catch (err) {
            // e.g. a corrupt file, or a .jpg that is actually something else
            console.warn(`Perceptual hash failed for ${filePath}, falling back to sha256: ${err.message}`);
        }
    }
    return `sha256:${await sha256File(filePath)}`;
};

const hashLocalNodes = async (nodes: localFileNode[], concurrency = 8): Promise<void>
    // process the nodes in slices of `concurrency` with Promise.all, setting node.imageHash = await computeFileHash(node.source, node.extension)
    // log progress every N files, because hashing a large directory takes a while
```

Notes:
- `node.source` already holds the absolute file path (`${directoryPath}/${fileUrl}`), so it is the right input.
- Stream the SHA-256 so large videos are never read into memory all at once.
- If even the SHA-256 fails (for example, the file can't be read), log the error and **skip that node** instead of inserting a row without a hash. `imageHash` is `NOT NULL` in the schema.
- No new dependencies. The small concurrency limiter is written inline.

## Step 3: Local repository (`repository/local.ts`)

1. **Schema**: add `imageHash TEXT NOT NULL`, plus a non-unique index:
   ```sql
   CREATE TABLE Local (name TEXT, extension TEXT, is_video BOOL, imageURL TEXT UNIQUE, previewURL TEXT,
                       source TEXT, imageHash TEXT NOT NULL, mediaID INT);
   CREATE INDEX IF NOT EXISTS idx_local_imageHash ON Local(imageHash);
   ```
   The index is non-unique on purpose: duplicate files are allowed in Local and are merged at the Media level.
2. **`insertLocalNodes`**: add `imageHash` to the column list, placeholders and values.
3. **Chunk the bulk insert** (for example, 500 rows per statement). With 8 values per row, a large directory can go over SQLite's bound-parameter limit (`SQLITE_MAX_VARIABLE_NUMBER`). The current single statement then fails and inserts nothing. Wrap the chunks in one `BEGIN`/`COMMIT` so a failure doesn't leave the import half-done.

## Step 4: Local service (`service/localFileService.ts`)

`createLocalNodes` becomes:
1. `readdirSync` → `initializeLocalNodes(...)` (unchanged, still synchronous; `imageHash` starts as `''`).
2. `await hashLocalNodes(localNodes)`, then drop any nodes whose hashing failed.
3. `await insertLocalNodes(...)`.

## Step 5: Media repository (`repository/media.ts`)

1. **Schema**: add `imageHash TEXT NOT NULL UNIQUE`. One Media row per distinct image is now enforced by the database. Keep `imageURL`, but it is no longer used for comparisons; it only records the representative file's URL.

2. **`populateMediaFromSource`**: replace the read-in-JS-then-bulk-insert approach with a single `INSERT ... SELECT`. This removes the parameter-limit problem, the missing-`rowid` bug (see the SQL-problems list), and the "inserts everything, linked or not" problem in one go:
   ```sql
   INSERT INTO Media (type, isMounted, tags, imageURL, imageHash, sourceID, mediaCollectionID, userDataID)
   SELECT ?, 1, NULL, imageURL, imageHash, MIN(rowid), NULL, NULL
   FROM Local
   WHERE imageHash NOT IN (SELECT imageHash FROM Media)
   GROUP BY imageHash;
   ```
   `sourceTable` stays a parameter for `type`. The table name in `FROM` is still interpolated, so check it against an allow-list (`['Local']`) before building the query. SQLite returns `imageURL` from the same row that `MIN(rowid)` picked, which is a documented SQLite behavior for bare columns with `MIN`/`MAX`. That is what makes the representative choice deterministic.

3. **`syncUnlinkedLocalNodes`**: compare on the hash, and only touch rows that actually have a match, so files with no match keep `-1` instead of being set to `NULL`. **Export it** (it is currently neither exported nor called).
   ```sql
   UPDATE Local
   SET mediaID = (SELECT Media.rowid FROM Media WHERE Media.imageHash = Local.imageHash)
   WHERE Local.mediaID = -1
     AND EXISTS (SELECT 1 FROM Media WHERE Media.imageHash = Local.imageHash);
   ```
   `Media.imageHash` is `UNIQUE`, so the subquery returns at most one row.

4. **`synchronizeMedia`**: compare on the hash, using `EXISTS` instead of a LEFT JOIN plus `IS NOT NULL`:
   ```sql
   UPDATE Media
   SET isMounted = 1
   WHERE isMounted = 0
     AND EXISTS (SELECT 1 FROM Local WHERE Local.imageHash = Media.imageHash);
   ```

5. **`getMedia`**: join on the real foreign key, `Local.mediaID = Media.rowid`, instead of the URL. Return one row per Media using the representative Local file, and alias the id explicitly:
   ```sql
   SELECT Media.rowid AS id, Media.imageHash, Media.tags,
          Local.name, Local.extension, Local.is_video, Local.imageURL, Local.previewURL, Local.source
   FROM Media
   JOIN Local ON Local.rowid = Media.sourceID;
   ```
   Media rows whose files aren't mounted are hidden by the inner join. That matches today's behavior, since only Local-backed rows are returned now.

## Step 6: Media service (`service/mediaService.ts`)

- Map `id: row.id` (the alias from step 5) and `imageHash: row.imageHash`.
- Fix `previewURL: row.imageURL` → `row.previewURL`. They hold the same value today, but it is the wrong column.

## Step 7: Startup order (`app.js`)

The current chain has a race: `createLocalNodes` is called without `await` inside the loop, and `synchronizeMedia` runs inside a `.then` that isn't awaited, before `populateMediaFromSource`. Hashing makes `createLocalNodes` much slower, so `populateMediaFromSource` would reliably run against an empty `Local` table. The new order:

```js
open({...}).then(async (db) => {
  await initializeLocalDB(db, true);
  await initializeMediaDB(db, true);
  for (const directory of directories) {
    try { await createLocalNodes(directory.name, directory.path, db, fs); }
    catch (err) { console.error(err.message); }
  }
  await populateMediaFromSource('Local', db);
  await syncUnlinkedLocalNodes(db);
  await synchronizeMedia(db, true);
  console.log('Database ready');
}).catch(err => console.error('Database initialization failed:', err));
```

Requests to `/media` that arrive before "Database ready" will see partial data. That's fine for this scope, but worth knowing.

## Step 8: `specs/01-convert-to-image-hash/sql-problems.md`

The spec asks for this file. Write it during implementation and include at least the issues found while planning. For each one, show the faulty SQL, explain why it's wrong and describe the fix:

1. **`populateMediaFromSource` reads `row.rowid` after a `SELECT *`.** `SELECT *` doesn't include the hidden `rowid` column, so every `sourceID` is inserted as `NULL`.
2. **`populateMediaFromSource` inserts every Local row, not just unlinked ones.** The commented-out LEFT JOIN was the start of an anti-join (`... WHERE Media.rowid IS NULL`) that was never finished. Once data persists, every restart would duplicate Media rows.
3. **A single bulk `INSERT` with N×7 placeholders** can go over SQLite's bound-parameter limit for large directories. The whole insert then fails and nothing is inserted (the error is only logged).
4. **`syncUnlinkedLocalNodes` sets `mediaID` to `NULL` when nothing matches.** A scalar subquery with no rows evaluates to `NULL`, so the `-1` "unlinked" marker is lost. With duplicate URLs or hashes it would pick an arbitrary match. It is also never exported or called, so `Local.mediaID` is always `-1`.
5. **`synchronizeMedia` uses `LEFT JOIN ... WHERE Local.imageURL IS NOT NULL`.** That filter turns it back into an inner join. It works, but `EXISTS` (or `INNER JOIN`) says what it means.
6. **`getMedia` uses `SELECT Media.rowid, *` over a join.** Both tables have an `imageURL` column, so the result has duplicate keys and the driver keeps whichever comes last. `id` is unreliable for Local rows with no Media match (it ends up `NULL`). It joins on URL even though a real foreign key (`Local.mediaID`) exists.
7. **Media's `FOREIGN KEY`s point at tables that don't exist** (`Collections_Media`, `UserData`). SQLite only accepts this because foreign-key enforcement is off by default (`PRAGMA foreign_keys`). Also, `REFERENCES Collections_Media(mediaID)` points the wrong way: a join table should reference Media, not the other way round.
8. **Table names are interpolated into SQL** (`${sourceTable}`). This is safe today because the value is hard-coded, but it is an injection risk if it ever comes from a request. Identifiers can't be bound as parameters, so check them against an allow-list.
9. **Startup ordering race in `app.js`** (step 7). This is about async code rather than SQL, but it is the reason sync queries run against empty tables.
10. **Schema and entity drift:** `localFileNode` has `width` and `height`, but `Local` has no such columns, and `is_video BOOL` is stored as `0`/`1`. That last one is SQLite's lack of a real boolean type, and the reason `is_video` comes back as a number in JSON.

Add any new issues found while implementing.

## Step 9: Verification

There is no test framework in the project, so verify by hand:

1. `node -v` → `v23.11.0`; `npm run build` passes with no type errors.
2. Create a test folder (outside the repo) containing:
   - `a.jpg`, `a-copy.jpg` (byte-identical), `a-resized.jpg` (the same picture, re-saved smaller)
   - `b.png`, `c.webp`
   - `anim.gif`, `anim-copy.gif`, `clip.mp4`
   - `broken.jpg` (a text file renamed to `.jpg`)
   
   Point `directories.json` at it temporarily, or add it as a second entry.
3. `npm start`, then check with a throwaway query script (in the scratchpad, not the repo):
   - Every `Local.imageHash` is non-null and starts with `phash:` or `sha256:`. `broken.jpg` got `sha256:` and a warning was logged.
   - `a.jpg`, `a-copy.jpg` and `a-resized.jpg` have the same `phash:` value. `anim.gif` and `anim-copy.gif` have the same `sha256:` value.
   - `SELECT COUNT(*) FROM Media` = `SELECT COUNT(DISTINCT imageHash) FROM Local`.
   - `SELECT COUNT(*) FROM Local WHERE mediaID = -1 OR mediaID IS NULL` = 0.
   - Every `Media.isMounted` = 1; `Media.sourceID` is non-null.
4. `GET /media` returns one entry per distinct image, with working `imageURL`s and a numeric `id`.
5. Point it at the real `hydrus` directory, note how long startup hashing takes, and confirm that no bulk insert errors are logged.
6. Restore `directories.json`.

## Notes for the persistence work later (not part of this plan)

- Hashing runs on every startup because the tables are dropped. Once the database persists, store `size` and `mtime` on Local and only re-hash files where either one changed. That's the main startup-time win.
- `Media.imageHash UNIQUE` plus `INSERT ... WHERE imageHash NOT IN (...)` is already safe to run more than once, which persistence needs.
- Perceptual hash collisions between images that are actually different are possible but weren't seen at 16 bits in testing. About a third of resized copies miss an exact match. If either problem matters later, the fix is to compare Hamming distance (a near-match threshold) instead of exact equality, or to add a SHA-256 column. The schema shape doesn't need to change.

## Files touched

| File | Change |
| --- | --- |
| `entity/localFileNode.ts`, `entity/mediaNode.ts` | Add `imageHash` |
| `service/hashService.ts` | **New**: perceptual/SHA-256 hashing with limited concurrency |
| `service/localFileService.ts` | Hash nodes before inserting |
| `repository/local.ts` | Column + index, chunked transactional insert |
| `repository/media.ts` | Column + unique constraint; rewrite populate, sync-unlinked, synchronize and getMedia on the hash / foreign key; export `syncUnlinkedLocalNodes` |
| `service/mediaService.ts` | Map `id` / `imageHash`, fix `previewURL` |
| `app.js` | Sequential, awaited startup order |
| `specs/01-convert-to-image-hash/sql-problems.md` | **New**: write-up of the SQL problems |
| `package.json` | Optional `engines.node` |
