Currently, the database is dropped and recreated on every server start. The intended behavior is for the database to persist between server starts and stops. On startup, the server should bring the database up to date with the files in the directories from `directories.json`.

Persistence was originally turned off because of unresolved SQL issues and a race condition in `app.js`. Those were fixed as part of the image-hash work (`specs/convert-to-image-hash/`), so this spec covers what's left.

## Why "stop dropping the tables" isn't enough
- `initializeLocalDB()` and `createLocalTable()` default `drop` to `true`, so removing the argument in `app.js` still drops `Local`.
- The tables are created with plain `CREATE TABLE`, which fails on the second start ("table already exists"). In `createLocalTable()`, that failure also skips creating the `imageHash` index.
- `createLocalNodes()` inserts every file on every start. Once rows persist, the first file already in the table breaks the `imageURL UNIQUE` constraint, and the whole transaction rolls back, so new files would never be added.
- Rows are identified by SQLite's hidden `rowid`. `VACUUM` can renumber it, and the id of the last deleted row can be reused. Once data persists, `Local.mediaID`, `Media.sourceID`, the API's `id`, and future tags and user data all depend on ids that never change.
- Nothing handles files that were changed or deleted between starts, or directories that were renamed or removed.

## Spec

### Schema
- Both tables get an explicit `id INTEGER PRIMARY KEY AUTOINCREMENT`. Every reference (`Local.mediaID`, `Media.sourceID`, the API `id`) uses it instead of `rowid`.
- Tables are created only if they don't exist. Nothing is dropped during normal startup.
- Track the schema version with `PRAGMA user_version`. On startup, run any migrations needed to reach the current version.
  - The databases that exist today have no version (`0`) and only hold data rebuilt on every start. The first migration may drop and recreate both tables.
- `Local` stores, for each file:
  - the absolute file path (`source`, `UNIQUE`). This is what identifies a file across restarts.
  - the folder it came from (`directoryPath`)
  - its `size` and `mtime`, used to skip re-hashing files that haven't changed
- `Media.imageURL` is removed. It goes stale when files change, and `getMedia()` already takes URLs from the representative `Local` row.

### Hash settings
- The perceptual hash prefix includes its bit count, `phash16:<hex>`, so hashes made with different settings can never be mistaken for each other.
- On startup, any file whose stored hash doesn't use the current settings is re-hashed, even if it hasn't changed.

### Startup sync for each directory in `directories.json`
| File state | Action |
| --- | --- |
| On disk, not in `Local` | Hash it and insert it. |
| In `Local`, size and mtime unchanged, hash up to date | Don't re-hash. Update the name and URLs if the directory's `name` changed. |
| In `Local`, size or mtime changed (or the hash settings are out of date) | Re-hash it, store the new hash, size and mtime, and set `mediaID` back to unlinked so it gets re-linked. |
| In `Local`, no longer on disk | Delete the `Local` row. |

- `Local` rows whose `directoryPath` is no longer in `directories.json` are deleted.
- Changing a directory's `name` only changes URLs (no re-hashing). Changing its `path` counts as removing the old directory and adding a new one.
- Startup logs a per-directory summary: new, changed, unchanged and removed.

### Media after syncing
- `Media` rows are **never deleted** by startup sync. A Media row with no files left gets `isMounted = 0` and keeps its tags. If a file with the same hash comes back, it re-links to the same row.
- After `Local` is synced: create Media rows for new hashes, link unlinked `Local` rows, re-point each Media row's `sourceID` to a file that still exists, then update `isMounted`. These steps are safe to run any number of times.
- `/media` only returns mounted Media rows.

## Out of scope
- **Hashing in the background while the server runs.** _Now done in `specs/background-perceptual-hash/`: the identity hash became sha256, which is fast enough for startup, and perceptual hashes moved to a background job. The original note follows._ Hashing is by far the slowest part of startup, so moving it to the background is worth exploring. It needs a refactor of the startup code, and `/media` would return partial results until hashing finishes (probably needing a status endpoint or flag). That's a separate spec.
- Near-match duplicate detection (`specs/near-match-duplicates/`), which depends on this spec.
- The foreign keys on `Media` that point at tables that don't exist yet (`Collections_Media`, `UserData`). See `specs/convert-to-image-hash/sql-problems.md` #7. They're unchanged until those tables are designed.
- Watching directories for changes while the server is running. Changes are picked up on the next start.

## Acceptance
- Start the server twice in a row: the second start hashes nothing, and `/media` returns the same ids both times.
- Between starts, add a file, edit a file, delete a file, add an exact duplicate of an existing file, rename a directory's `name`, and remove a directory from `directories.json`. After the next start, each case behaves as described in the sync table, and Media rows keep their ids and tags.
- Changing the hash bit count between starts re-hashes every perceptual-hashed file.
