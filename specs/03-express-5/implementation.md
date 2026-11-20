# Implementation Plan: Upgrade to Express 5

Implements `specs/03-express-5/spec.md`.

## Decisions

| Topic | Decision |
| --- | --- |
| Version | `express@^5.3.0`. No other dependencies change. |
| Where directory names are checked | Once, at the top of `app.js`. The valid directories are used for both the CDN mounts and startup sync, so a skipped directory is neither served nor synced. |
| Rows for a directory with an invalid name | **Kept**, the same as for a directory that can't be read (`specs/02-persistence/implementation.md`, step 5). Its path still goes to `deleteLocalNodesOutsideDirectories`. Otherwise a typo while renaming a directory would delete all its `Local` rows, and fixing the typo would mean re-hashing the whole folder. |
| `/media` connection leak | Left as it is. The handler only becomes `async`. Closing or sharing the connection belongs to `specs/06-media-route/`, which will change how the route gets its connection anyway. |

---

## Step 1: Dependency

```
npm install express@^5.3.0
```

This updates `package.json` and `package-lock.json`. Express 5 pulls in body-parser 2, serve-static 2, router 2 and path-to-regexp 8.

## Step 2: `app.js`

**Query parser.** Replace the broken statement:

```js
app.set('query parser'), function (str) {
  return qs.parse(str);
}
```

with:

```js
// Express 5 defaults to the 'simple' parser; 'extended' keeps nested queries like ?a[b]=1
app.set('query parser', 'extended');
```

Then delete `const qs = require('qs');`.

**Directory names.** After `directories` is loaded:

```js
// Directory names become route paths (/<name>/<file>). Express 5 rejects reserved characters
// in paths, so only allow names that are always safe.
const VALID_DIRECTORY_NAME = /^[A-Za-z0-9_-]+$/;
const validDirectories = directories.filter(directory => {
  if (!VALID_DIRECTORY_NAME.test(directory.name)) {
    console.error(`Skipping directory "${directory.name}" (${directory.path}): names may only contain letters, digits, - and _`);
    return false;
  }
  return true;
});
```

Then:
- The startup sync loop runs over `validDirectories`.
- `deleteLocalNodesOutsideDirectories` still gets the paths from **all** `directories` (see Decisions).
- The CDN loop (`app.use(`/${directory.name}`, express.static(...))`) runs over `validDirectories`.

The check runs when the module loads, before the CDN mounts, so an invalid name can never reach `app.use`.

## Step 3: `routes/external.js`

```js
router.get('/{*splat}', (req, res, next) => {
```

`*splat` is a named wildcard, and the braces make it optional, so it also matches `/external/` on its own, as `/*` did in Express 4. The matched path is in `req.params.splat` (an array of path segments), which the handler doesn't use.

## Step 4: `routes/media.js`

Rewrite `GET /` as an `async` handler:

```js
router.get('/', async (req, res) => {
    const db = await open({
        filename: './db/media.sqlite3',
        driver: sqlite3.Database
    });
    res.json(await getMediaNodes(db));
});
```

If `open` or the query rejects, Express 5 passes the error to the error handler in `app.js`, which responds with a 500. Nothing else in the file changes.

## Step 5: Verification

Run the real server on a spare port (`PORT=3999`), as in the persistence work.

1. **Startup:** `npm start` builds without errors. The log shows the usual per-directory summary and `Database ready`.
2. **Unchanged responses:** save `GET /media` and `GET /local` before upgrading (from the current build), then compare them after. They should be byte-identical.
3. **External wildcard:** `GET /external/anything`, `GET /external/a/b` and `GET /external/` all return "error: unsupported external site". `GET /external/gelbooru` still returns its own stub.
4. **Media files:** a file URL from `/media` returns 200 with the file's size.
5. **Invalid directory name:** temporarily add `{"name": "my (pics)", "path": "<scratchpad folder>"}` to `build/directories.json`. The error is logged, the server starts, `/media` works, and the test folder's files aren't synced. Then change the hydrus entry's name to `hydrus!`: its rows are kept (row count unchanged in `Local`), and it isn't served. Restore the file.
6. **Async errors:** temporarily break the query in `build/repository/media.js` (for example, select a column that doesn't exist). `GET /media` returns 500, and a second request also returns 500, which shows the server is still running. Rebuild to restore it.
7. **Query parser:** with a throwaway script, load the built app and check that `app.get('query parser fn')('a[b]=1')` returns `{ a: { b: '1' } }`.
8. **Lockfile:** `npm ls express` shows `express@5.x`, and nothing in `npm ls` reports invalid or missing dependencies.

## Files touched

| File | Change |
| --- | --- |
| `package.json`, `package-lock.json` | `express@^5.3.0` |
| `app.js` | `query parser` set to `'extended'`, `qs` require removed, directory names validated before sync and CDN mounts |
| `routes/external.js` | `/*` becomes `/{*splat}` |
| `routes/media.js` | `GET /` is an `async` handler |
