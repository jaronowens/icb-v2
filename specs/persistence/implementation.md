# Implementation Plan: Persist the database between server starts

Implements `specs/persistence/spec.md`. It builds on the image-hash work (commit `5859dbc`), which fixed the startup race and the sync queries.

## Decisions

| Topic | Decision |
| --- | --- |
| Where tables are created | One new module, `repository/schema.ts`, runs versioned migrations. The `drop` arguments, `initializeLocalDB`, `createLocalTable` and `initializeMediaDB` are removed instead of having their defaults patched, so there's nothing left that can drop a table by accident. |
| First migration | The current databases have no version (`user_version = 0`) and only hold data rebuilt on every start. Migration `0 → 1` drops both tables and creates the v1 schema. Every later migration must keep existing data. |
| File identity | `Local.source` (the absolute path) is `UNIQUE` and is what matches a file across restarts. `imageURL` is derived from the directory name and is no longer `UNIQUE`. |
| Unlinked marker | Keep `mediaID = -1` for unlinked rows, as the existing queries expect. |
| Hash prefix | `phash16:` (built from `HASH_BITS`). `sha256:` is unchanged. |
| Transactions | Each directory's sync runs in one transaction. `insertLocalNodes` stops opening its own transaction, because SQLite can't nest `BEGIN`. |

---

## Step 1: Schema and migrations (`repository/schema.ts`, new)

```ts
const CURRENT_VERSION = 1;

const migrations: Record<number, (db) => Promise<void>> = {
    // 0 -> 1: data before this point was rebuilt on every start, so it's safe to throw away
    1: async (db) => {
        await db.run('DROP TABLE IF EXISTS Local');
        await db.run('DROP TABLE IF EXISTS Media');
        await db.run(`CREATE TABLE Local (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT, extension TEXT, is_video BOOL,
            directoryPath TEXT NOT NULL,
            source TEXT NOT NULL UNIQUE,
            imageURL TEXT, previewURL TEXT,
            size INTEGER NOT NULL, mtimeMs INTEGER NOT NULL,
            imageHash TEXT NOT NULL,
            mediaID INTEGER NOT NULL DEFAULT -1)`);
        await db.run('CREATE INDEX idx_local_imageHash ON Local(imageHash)');
        await db.run('CREATE INDEX idx_local_directoryPath ON Local(directoryPath)');
        await db.run(`CREATE TABLE Media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT, isMounted BOOL, tags TEXT,
            imageHash TEXT NOT NULL UNIQUE,
            sourceID INTEGER,
            mediaCollectionID INTEGER, userDataID INTEGER,
            FOREIGN KEY (mediaCollectionID) REFERENCES Collections_Media(mediaID),
            FOREIGN KEY (userDataID) REFERENCES UserData(rowid))`);
    },
};

const migrate = async (db) => {
    const { user_version } = await db.get('PRAGMA user_version');
    for (let v = user_version + 1; v <= CURRENT_VERSION; v++) {
        console.log(`Migrating database schema to version ${v}`);
        await db.run('BEGIN');
        try {
            await migrations[v](db);
            await db.run(`PRAGMA user_version = ${v}`);   // pragmas can't take bound parameters; v is a number from this file
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;   // don't start the server on a half-migrated schema
        }
    }
};
```

Notes:
- `AUTOINCREMENT` makes sure an id is never reused, even after the row with the highest id is deleted. That matters because `Local.mediaID`, `Media.sourceID` and future user data store these ids.
- An explicit `INTEGER PRIMARY KEY` also keeps `VACUUM` from renumbering rows.
- The `Media` foreign keys stay as they are (out of scope; see `sql-problems.md` #7). `Media.imageURL` is gone.
- Later migrations are added to the `migrations` map by bumping `CURRENT_VERSION`. Each one runs in its own transaction.

## Step 2: Entities

**`entity/localFileNode.ts`**: add `directoryPath: string`, `size: number` and `mtimeMs: number`. Optionally add `id?: number` for rows read back from the database.

**`entity/mediaNode.ts`**: no change. `id` now comes from `Media.id`.

## Step 3: Hash settings (`service/hashService.ts`)

- Build the prefix from the setting: `const PHASH_PREFIX = \`phash${HASH_BITS}:\``, and use it in `computeFileHash`.
- Export `isCurrentHash(hash: string): boolean`, which returns true when the hash starts with `PHASH_PREFIX` or `sha256:`. A `sha256:` hash on a jpg or png (from a failed perceptual hash) counts as current, so files that can't be decoded aren't retried on every start.
- `hashLocalNodes` doesn't change. It already returns only the nodes that were hashed successfully.

## Step 4: Local repository (`repository/local.ts`)

Remove `createLocalTable`. Add or replace:

| Function | SQL / behavior |
| --- | --- |
| `readLocalNodesForDirectory(db, directoryPath)` | `SELECT id, source, size, mtimeMs, imageHash, imageURL FROM Local WHERE directoryPath = ?` |
| `insertLocalNodes(db, nodes)` | Same 500-row chunked insert as now, with the new columns, **without** its own `BEGIN`/`COMMIT`. |
| `updateChangedLocalNodes(db, nodes)` | For each node: `UPDATE Local SET imageHash = ?, size = ?, mtimeMs = ?, mediaID = -1 WHERE source = ?` |
| `updateLocalNodeURLs(db, nodes)` | For each node: `UPDATE Local SET name = ?, imageURL = ?, previewURL = ? WHERE source = ?`. Only called for rows whose URL actually changed. |
| `deleteLocalNodes(db, sources)` | `DELETE FROM Local WHERE source IN (...)`, in chunks of 500. |
| `deleteLocalNodesOutsideDirectories(db, directoryPaths)` | `DELETE FROM Local WHERE directoryPath NOT IN (?, ?, ...)`. With an empty list, delete every row. |

The per-row `UPDATE`s run inside the directory's transaction (step 5), which makes them fast. A prepared statement (`db.prepare`) run in a loop is the tidy way to do it.

## Step 5: Local sync (`service/localFileService.ts`)

Replace `createLocalNodes` and `initializeLocalDB` with `syncDirectory(directoryName, directoryPath, db, fs)`:

1. **Scan:** `readdirSync`, keep supported file types, `statSync` each one, and build a node (as `initializeLocalNode` does now) with `directoryPath`, `size = stat.size` and `mtimeMs = Math.floor(stat.mtimeMs)`. A file that disappears between listing and `stat` is logged and skipped.
2. **Load:** `readLocalNodesForDirectory` → a `Map` keyed by `source`.
3. **Classify** each scanned file:
   - not in the map → **new**
   - `size` or `mtimeMs` differs, or `!isCurrentHash(row.imageHash)` → **changed**
   - otherwise → **unchanged**. If `row.imageURL !== node.imageURL` (the directory's `name` changed), also add it to **urlChanged**.
   - Rows left in the map that aren't on disk → **missing**.
4. **Hash:** `hashLocalNodes([...new, ...changed])`. Files that fail to hash are dropped. A changed file that fails keeps its old row, and is tried again next start because its size/mtime still won't match.
5. **Write**, in one transaction (`BEGIN` … `COMMIT`, `ROLLBACK` on error): `insertLocalNodes(new)`, `updateChangedLocalNodes(changed)`, `updateLocalNodeURLs(urlChanged)`, `deleteLocalNodes(missing)`.
   - For changed files, the URLs are written as part of the same update, so a renamed directory plus an edited file is handled in one pass.
6. **Log:** `hydrus: 3 new, 1 changed, 665 unchanged, 1 removed`.

A directory that can't be read (`readdirSync` throws, e.g. a drive that isn't connected) is logged and **skipped without touching its rows**. Otherwise an unplugged drive would delete all its `Local` rows. Those rows stay until the directory is either readable again or removed from `directories.json`.

## Step 6: Media repository (`repository/media.ts`)

Remove `initializeMediaDB`. Then:

1. **`populateMediaFromSource`:** drop `imageURL` from the insert, and use `MIN(id)` for `sourceID`:
   ```sql
   INSERT INTO Media (type, isMounted, tags, imageHash, sourceID, mediaCollectionID, userDataID)
   SELECT ?, 1, NULL, imageHash, MIN(id), NULL, NULL
   FROM Local
   WHERE imageHash NOT IN (SELECT imageHash FROM Media)
   GROUP BY imageHash;
   ```
2. **`syncUnlinkedLocalNodes`:** `Media.rowid` → `Media.id`. No other change.
3. **New `refreshMediaSources(db)`:** re-points every Media row to a file that still exists (or to `NULL` if there's none):
   ```sql
   UPDATE Media
   SET sourceID = (SELECT MIN(Local.id) FROM Local WHERE Local.imageHash = Media.imageHash);
   ```
   This runs over all Media every start. That's a single indexed query, so it's cheaper than tracking which rows went stale.
4. **`synchronizeMedia`:** unchanged. The reset-then-mount logic is already correct with persisted data.
5. **`getMedia`:** use `Media.id` and only return mounted rows:
   ```sql
   SELECT Media.id AS id, Media.imageHash, Media.tags,
          Local.name, Local.extension, Local.is_video, Local.imageURL, Local.previewURL, Local.source
   FROM Media
   JOIN Local ON Local.id = Media.sourceID
   WHERE Media.isMounted = 1;
   ```

Export `refreshMediaSources`, and stop exporting `initializeMediaDB`.

## Step 7: Startup (`app.js`)

```js
open({...}).then(async (db) => {
  await migrate(db);
  for (const directory of directories) {
    try { await syncDirectory(directory.name, directory.path, db, fs); }
    catch (err) { console.error(`Failed to sync ${directory.path}:`, err.message); }
  }
  await deleteLocalNodesOutsideDirectories(db, directories.map(d => d.path));
  await populateMediaFromSource('Local', db);
  await syncUnlinkedLocalNodes(db);
  await refreshMediaSources(db);
  await synchronizeMedia(db, true);
  console.log('Database ready');
}).catch(...);
```

The order matters:
1. All `Local` changes happen first.
2. New hashes then get Media rows.
3. Unlinked files get linked.
4. Representatives get re-pointed.
5. `isMounted` is recalculated last, so it sees the final state.

Update the `require` lines to match the removed and new exports.

`deleteLocalNodesOutsideDirectories` runs after every directory sync, including ones that were skipped because they couldn't be read. Those paths are still in `directories.json`, so their rows are kept.

## Step 8: Other code

- **`service/mediaService.ts`:** no change needed (`row.id` is already used).
- **`routes/local.js`:** `SELECT * FROM Local` now also returns `id`, `directoryPath`, `size`, `mtimeMs`. Harmless.
- **`routes/media.js`:** opens its own connection on each request. That's fine with persistence, but note that it now reads a database that may be mid-sync during startup, the same as before.
- **`specs/convert-to-image-hash/spec.md`:** the persistence section now points here.

## Step 9: Verification

Use a test folder in the scratchpad, as in the image-hash work: a few jpgs and pngs, an exact copy, a gif, an mp4. Use a throwaway query script for the database checks.

1. **First start (migration):** the log shows "Migrating database schema to version 1", every file is new, and `PRAGMA user_version` = 1.
2. **Second start with nothing changed:** every file is unchanged, the log shows no "Hashed" lines, and the `/media` ids are identical to the first run.
3. Stop the server, then make the changes below and start again:
   - **Add `new.jpg`:** 1 new, a new Media row is created.
   - **Edit `a.jpg`** (re-save with different content): 1 changed. Its Local row keeps the same `id`, gets a new hash, and links to a different Media row. If that row is now empty, the old Media row has `isMounted = 0` but still exists, with the same id and tags.
   - **Delete `b.png`:** 1 removed. Its Media row is unmounted and not deleted.
   - **Restore `b.png`** on the next start: it re-links to the **same** Media id. Set a tag on that row by hand first to confirm the tag survives.
   - **Delete the representative of a duplicate pair:** the Media row stays mounted, `sourceID` moves to the remaining copy, and `/media` still lists it.
   - **Rename the directory's `name`** in `directories.json`: 0 hashed, all URLs updated, `/media` URLs load.
   - **Remove the directory** from `directories.json`: all its Local rows are deleted and its Media rows unmounted.
   - **Point a directory at a path that doesn't exist:** the error is logged and its rows are untouched.
4. **Hash settings:** temporarily set `HASH_BITS = 8` and start: every perceptual-hashed file is changed and re-hashed with `phash8:`. Set it back, and start again: they're re-hashed again with `phash16:`. Old Media rows are unmounted, not deleted.
5. **Timing:** start against the real hydrus folder twice and note both startup times. The second start should take seconds.
6. Restore `directories.json`.

## Files touched

| File | Change |
| --- | --- |
| `repository/schema.ts` | **New**: `user_version` migrations, schema v1 |
| `entity/localFileNode.ts` | Add `directoryPath`, `size`, `mtimeMs` (and optional `id`) |
| `service/hashService.ts` | `phash<bits>:` prefix, `isCurrentHash` |
| `repository/local.ts` | Remove `createLocalTable`; per-directory read, insert without its own transaction, update, delete helpers |
| `service/localFileService.ts` | `syncDirectory` replaces `createLocalNodes` / `initializeLocalDB` |
| `repository/media.ts` | Remove `initializeMediaDB` and `Media.imageURL`; `rowid` → `id`; add `refreshMediaSources`; `getMedia` returns only mounted rows |
| `app.js` | Migrate → sync directories → remove unconfigured directories → populate → link → refresh sources → mount |
