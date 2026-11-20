# Implementation Plan: Media Endpoints

Implements `specs/06-media-route/spec.md`.

## Decisions

| Topic | Decision |
| --- | --- |
| Where readiness lives | `app.locals.dbStatus` (`'starting' \| 'ready' \| 'failed'`) and `app.locals.dbError`. `createApp` takes a new required `ready: Promise<unknown>` option (the promise `startup()` returns) and updates the status when it settles. `createApp` still has no side effects of its own: it only listens to a promise the caller made. |
| What gets the readiness gate | Everything under `/media`, all methods, including `POST`. `/status`, `/`, the CDN directories, `/collection` and `/external` are not gated. Gating `POST` also prevents a real bug: sync and `POST` share one connection, so a `BEGIN` from `POST` during sync would fail with "cannot start a transaction within a transaction". |
| `Retry-After` | `5` seconds. Only sent while `starting`. A `failed` database won't recover without a restart, so it gets no `Retry-After`. |
| Error message in JSON | `{ "error": err.message }` for every status, including 500s. This is a local, single-user app, and the SQLite message is the useful part. In development, `stack` is added too. Only 500s are logged with `console.error`. The deliberate 503s and 501s aren't, because a front end polling during startup would flood the log. |
| Which paths get the pug page | Only `req.path === '/'`. Everything else, including 404s for missing CDN files, gets JSON. |
| How `/media/:id` finds files | `Local.mediaID = Media.id`, ordered by `Local.id`. After sync this matches `refreshMediaSources`, which picks `MIN(Local.id)` for the hash, so the representative is always first. |
| Unmounted shape | The same keys as a `GET /media` entry. The Local-derived ones (`name`, `width`, `height`, `extension`, `is_video`, `source`, `imageURL`, `previewURL`) are `null`. The service nulls them whenever `isMounted` is 0, even if `sourceID` still points at a row. |
| `GET /media/unmounted` shape | The unmounted shape plus `isMounted: false`. There is no `files` key, because it would always be empty. |
| `is_video` | Left as SQLite returns it (`0`/`1`), so `GET /media` doesn't change. `isMounted` is a new field, so it's converted to a real boolean. |
| `POST /media` body | `{ "filepath": "<absolute path>" }`. |
| Which paths `POST` accepts | **Only files directly inside a folder in `directories.json`** (with a valid name). Startup sync only scans the top level of those folders and deletes rows outside them, and the app only serves files from them. A file anywhere else gets a 400. In practice, `POST` registers a file that's already in a mounted folder without waiting for a restart. |
| Matching a folder | Compare `path.resolve(path.dirname(filepath))` to `path.resolve(directory.path)`, case-insensitively on Windows. The stored `source` is built the way startup builds it (`${directory.path}/${basename}`), so the next sync sees it as the same row (`source` is `UNIQUE`), not a new one. |
| Supported types | The same extension check startup uses (`isValidFile`). As at startup, a non-image with an image extension (`not-an-image.png`) is accepted and falls back to a sha256 hash. "Incorrect file type" means an unsupported extension. |
| Duplicates | Matches startup sync. If the hash is new, `POST` creates a Media row and returns **201** `{ id }`. If the hash matches an existing Media row, `POST` adds the Local row, links it to that Media row, mounts it if it was unmounted, and returns **200** `{ id }` with the existing id. If the file is already registered (same `source`), nothing changes and the response is **200** `{ id }` with its Media id. |
| Concurrent `POST`s | Writes are serialized with a small in-process lock around `BEGIN`…`COMMIT` (`util/transaction.ts`). Hashing and measuring happen *before* the lock is taken, so a slow hash doesn't block other writers. |
| `PUT` / `DELETE` | `501` for `/media` and `/media/:id`, whatever the id. |

---

## Step 1: Readiness in `app.ts` and `bin/www.ts`

`app.ts`:

```ts
type DbStatus = 'starting' | 'ready' | 'failed';

type AppOptions = {
  db: Database | Promise<Database>,
  directories: Directory[],
  /* Settles when startup sync finishes: resolves once the database is ready, rejects if startup fails. */
  ready: Promise<unknown>,
};

// in createApp, next to app.locals.db
app.locals.directories = validDirectories;   // used by POST /media
app.locals.dbStatus = 'starting' as DbStatus;
app.locals.dbError = null;
ready.then(
  () => { app.locals.dbStatus = 'ready'; },
  err => { app.locals.dbStatus = 'failed'; app.locals.dbError = err; },
);
```

The rejection handler also counts as handling the promise, so a failed startup never becomes an unhandled rejection. `bin/www.ts` keeps logging the failure:

```ts
const ready = startup(dbConnection, directories);
ready.catch(err => console.error('Database initialization failed:', err));
const app = createApp({ db: dbConnection, directories, ready });
```

`startup()` already awaits the connection, so a connection that fails to open also ends up as `failed`.

## Step 2: Middleware, `routes/middleware.ts` (new)

```ts
/* Answers 503 for routes that read the database until startup sync has finished. */
const requireDatabase = (req, res, next) => {
  const { dbStatus, dbError } = req.app.locals;
  if (dbStatus === 'starting') {
    res.set('Retry-After', String(RETRY_AFTER_SECONDS));
    throw createError(503, 'Database is starting, try again shortly');
  }
  if (dbStatus === 'failed') {
    throw createError(503, `Database failed to initialize: ${dbError?.message ?? 'unknown error'}`);
  }
  next();
};

/* Parses :id as a positive integer, or throws 400. */
const parseId = (raw: string): number => { /* /^[1-9]\d*$/ and Number.isSafeInteger */ };
```

Mount it in `app.ts`: `app.use('/media', requireDatabase, mediaRouter);`.

## Step 3: Errors in `app.ts`

Replace the 404 handler and the error handler:

```ts
app.use((req, res, next) => {
  next(createError(404, `Not found: ${req.method} ${req.path}`));
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);   // let Express close the connection
  }
  const status = err.status || err.statusCode || 500;
  const isDevelopment = req.app.get('env') === 'development';
  if (status === 500) {   // deliberate 503s/501s aren't logged
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
  }
  res.status(status);

  if (req.path === '/') {
    res.locals.message = err.message;
    res.locals.error = isDevelopment ? err : {};
    return res.render('error');
  }
  res.json({ error: err.message, ...(isDevelopment ? { stack: err.stack } : {}) });
});
```

Malformed JSON bodies already arrive from `express.json()` as a 400 with `status` set, so they become a JSON 400 with no extra work.

## Step 4: `GET /status`, `routes/status.ts` (new)

```ts
router.get('/', (req, res) => {
  res.json({ database: req.app.locals.dbStatus });
});
```

Mount it at `/status` in `app.ts`, before the 404 handler and without `requireDatabase`.

## Step 5: Entities

`entity/mediaNode.ts`. `MediaNode` is unchanged. Add:

```ts
interface MediaFile {
  id: number; name: string; extension: string; is_video: boolean;
  imageURL: string; previewURL: string; source: string;
}

interface MediaDetail extends MediaNode {
  isMounted: boolean;
  files: MediaFile[];
}
```

For an unmounted row, the Local-derived `MediaNode` fields are `null`. `strict` is off, so the types say so in comments, as `width` already does.

## Step 6: Repository (`repository/media.ts`)

New functions, added next to `getMedia` (which doesn't change):

- **`getMediaById(db, id)`**: `SELECT Media.id, Media.imageHash, Media.tags, Media.isMounted, Local.name, … FROM Media LEFT JOIN Local ON Local.id = Media.sourceID WHERE Media.id = ?`, with `db.get`. Returns `undefined` if there's no such row.
- **`getUnmountedMedia(db)`**: `SELECT id, imageHash, tags FROM Media WHERE isMounted = 0 ORDER BY id`.
- **`getMediaIdByHash(db, imageHash)`**: `SELECT id, isMounted FROM Media WHERE imageHash = ?`.
- **`insertMedia(db, imageHash, sourceID)`**: `INSERT INTO Media (type, isMounted, tags, imageHash, sourceID, mediaCollectionID, userDataID) VALUES ('Local', 1, NULL, ?, ?, NULL, NULL)`, returning `lastID`. It uses the same column values as `populateMediaFromSource`.
- **`mountMedia(db, id)`**: `UPDATE Media SET isMounted = 1, sourceID = (SELECT MIN(id) FROM Local WHERE Local.imageHash = Media.imageHash) WHERE id = ?`.

`repository/local.ts`:

- **`getLocalNodesForMedia(db, mediaId)`**: `SELECT id, name, extension, is_video, imageURL, previewURL, source FROM Local WHERE mediaID = ? ORDER BY id`.
- **`getLocalNodeBySource(db, source)`**: `SELECT id, mediaID FROM Local WHERE source = ?`.
- **`linkLocalNode(db, localId, mediaId)`**: `UPDATE Local SET mediaID = ? WHERE id = ?`.
- `insertLocalNodes` stays as it is. `POST` reads the new id back with `getLocalNodeBySource`, so `insertLocalNodes` doesn't need to change.

## Step 7: Service (`service/mediaService.ts`)

1. Extract the row → `MediaNode` mapping from `getMediaNodes` into `toMediaNode(row)`. `getMediaNodes` uses it unchanged, so `GET /media` keeps the same keys in the same order.
2. **`getMediaDetail(db, id)`**: `getMediaById`. If there's no row it returns `null`. If `isMounted` is 1, the result is `{ ...toMediaNode(row), isMounted: true, files: await getLocalNodesForMedia(db, id) }`. Otherwise it's `{ ...unmountedNode(row), isMounted: false, files: [] }`, where `unmountedNode` sets every Local-derived field to `null`.
3. **`getUnmountedMediaNodes(db)`**: maps `getUnmountedMedia` rows through `unmountedNode` and adds `isMounted: false`.
4. **`addLocalFile(db, directories, filepath)`** returns `{ id, created }`. Validation failures are thrown as `createError(400, …)`:
   1. `filepath` must be a non-empty string, otherwise 400 `filepath is required`.
   2. Find the directory whose resolved path equals `path.dirname(path.resolve(filepath))`. If there isn't one, 400 `File must be directly inside a directory in directories.json`.
   3. `isValidFile(basename)`, otherwise 400 `Unsupported file type: .<ext>`.
   4. `fs.promises.stat`. `ENOENT`/`ENOTDIR`, or a stat that isn't a file, is 400 `File not found: <filepath>`.
   5. Build the node with `initializeLocalNode(`${BASE_URL}/${dir.name}`, dir.path, basename, stat.size, Math.floor(stat.mtimeMs))`.
   6. `hashLocalNodes([node])`. If nothing comes back, 400 `Could not read file`. Then `measureLocalNodes([node])`.
   7. `withTransaction(db, async () => { … })`:
      - If `getLocalNodeBySource(node.source)` already has a row, return `{ id: row.mediaID, created: false }`. Doing this check inside the lock covers two `POST`s of the same file. (The same check also runs before hashing, so re-posting a registered file skips the hash.)
      - `insertLocalNodes(db, [node])`, then read the new Local id.
      - If `getMediaIdByHash` finds a Media row, call `linkLocalNode`, and `mountMedia` if it wasn't mounted. Return `{ id, created: false }`.
      - Otherwise `insertMedia(db, node.imageHash, localId)`, then `linkLocalNode`. Return `{ id: newId, created: true }`.

Export `initializeLocalNode`, `isValidFile` and `BASE_URL` from `service/localFileService.ts` for step 5. `syncDirectory` doesn't change.

## Step 8: `util/transaction.ts` (new)

```ts
/* One queue per connection: node-sqlite3 has no nested transactions, and every request shares one connection. */
const queues = new WeakMap<object, Promise<unknown>>();

const withTransaction = async <T>(db, fn: () => Promise<T>): Promise<T> => {
  const previous = queues.get(db) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    await db.run('BEGIN');
    try {
      const result = await fn();
      await db.run('COMMIT');
      return result;
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }
  });
  queues.set(db, run.catch(() => {}));
  return run;
};
```

`syncDirectory` and `migrate` keep their own `BEGIN`s. They only run during startup, and the readiness gate keeps `POST` out until startup has finished.

## Step 9: Routes (`routes/media.ts`)

Order matters: `/unmounted` has to be registered before `/:id`.

```ts
router.get('/', async (req, res) => {
  res.json(await getMediaNodes(await req.app.locals.db));
});

router.get('/unmounted', async (req, res) => {
  res.json(await getUnmountedMediaNodes(await req.app.locals.db));
});

router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const media = await getMediaDetail(await req.app.locals.db, id);
  if (!media) {
    throw createError(404, `Media ${id} not found`);
  }
  res.json(media);
});

router.post('/', async (req, res) => {
  const { id, created } = await addLocalFile(await req.app.locals.db, req.app.locals.directories, req.body?.filepath);
  res.status(created ? 201 : 200).json({ id });
});

const notImplemented = () => { throw createError(501, '… is not implemented yet'); };
router.put(['/', '/:id'], notImplemented);
router.delete(['/', '/:id'], notImplemented);
```

Remove the old "Questions" comments. The `PUT` and `DELETE` messages point at the future specs: Tags, and the hash blacklist.

## Step 10: Test helper (`test/helpers/index.ts`)

`createTestApp({ directories, sync = true, ready })`:
- With `ready` given, it's passed straight to `createApp`. Readiness tests use this with a deferred promise they settle themselves.
- Otherwise `ready = sync ? startup(db, directories) : Promise.resolve()`, and the helper awaits it before returning. `createApp` attaches its handlers synchronously, so `dbStatus` is `'ready'` by the time a test sends a request.

Add a small `deferred()` helper that returns `{ promise, resolve, reject }`.

## Step 11: Tests

**`test/integration/status.test.ts`** (new)
- While starting, `GET /status` returns `{ database: 'starting' }`, and `GET /media` and `GET /media/1` return 503 with `Retry-After: 5` and a JSON error.
- After the deferred promise resolves, `/status` reports `ready` and `/media` returns 200.
- After it rejects with `new Error('boom')`, `/status` reports `failed`, `/media` returns 503 with an error containing `failed to initialize` and `boom`, and there is no `Retry-After`.

**`test/integration/errors.test.ts`** (new)
- On its own app, `DROP TABLE Local`, then `GET /media` returns a 500 JSON error, and `GET /status` still returns 200 afterwards.
- `/media/1/nope` and `/nope` return a 404 JSON error.
- `GET /` still returns HTML.
- `POST /media` with a malformed JSON body returns a 400 JSON error.
- Under `NODE_ENV=test` there's no `stack`.

**`test/integration/media.test.ts`** (extend)
- `GET /media`: assert every entry has exactly the 11 `MediaNode` keys. The existing tests already pin the content.
- `GET /media/:id`:
  - Scene A has 3 files ordered by id, `files[0].source === entry.source`, and `isMounted: true`.
  - A single file has one entry in `files`.
  - Insert an unmounted Media row (`isMounted = 0`, a hash no file has). It returns `isMounted: false`, `files: []`, `name: null`, and its `tags`.
  - `9999` returns 404, and `abc`, `0`, `-1` and `1.5` return 400.
- `GET /media/unmounted` contains that row and no mounted ones.
- `PUT /media/1`, `DELETE /media/1`, `PUT /media` and `DELETE /media` return 501 JSON.

**`test/integration/mediaPost.test.ts`** (new). It uses a temporary folder (`fs.mkdtemp` under `os.tmpdir()`), configured as `{ name: 'upload', path: tmp }`, so the fixtures folder is never written to.
- Copy `checker-b.jpg` in and `POST` it. The response is 201 `{ id }`. `GET /media/:id` shows 40×40, a `phash16:` hash, an `imageURL` under `/upload/` that the app serves, and one file.
- `POST` the same path again: 200 with the same id and still one Local row.
- Copy it again as `checker-b-copy.jpg` and `POST` it: 200 with the same id, and `files` now has 2 entries.
- A missing file, `notes.txt` (copied in), a file in the fixtures folder (not configured), a missing `filepath` and a non-string `filepath` each return 400.
- Run `startup(db, directories)` again on the same db. The posted rows are kept and not re-hashed (it logs `0 new, 0 changed`), and their ids don't change.
- Clean up the temp folder in `after`.

## Step 12: Check by hand against the real database

1. Before changing anything, run `npm start`, wait for `Database ready`, then save `curl localhost:3000/media > before.json` (in the scratchpad, not the repo).
2. After the change, restart, poll `curl localhost:3000/status` and `/media` while it hashes (with `-i` to see the 503 and `Retry-After`), then save `after.json` and confirm `diff before.json after.json` is empty.
3. Mark the "Media Endpoints" row in `README.md` as ✅.

## Not changed

- `/collection` and `/external` stubs, apart from errors now coming back as JSON.
- `util/httpRequests.ts`.
- Startup sync, migrations and the schema. No migration is needed.

## Implementation notes

What changed while building it:
- **Logging:** only 500s are logged (see Decisions). The plan logged every 5xx, which in a first run logged a full stack for every `503` while starting.
- **Already-registered check:** `addLocalFile` checks for an already-registered file before hashing as well as inside the lock.
- **`parseId`:** also rejects leading zeros (`01`), so each item has exactly one URL.
- **Unmounted rows:** `toMediaNode` and `unmountedNode` both list the keys explicitly, in the same order. That keeps `GET /media` unchanged and gives unmounted entries the same keys.
- **Startup re-sync test:** in `mediaPost.test.ts` it sits in a nested `describe`, so Mocha runs it after the 400 cases. It also checks that startup skips the files those cases leave behind (`notes.txt`, a subfolder, a folder named `folder.jpg`).
- **Hand check (step 12):** done with copies of `db/media.sqlite3`. The old build (`HEAD`) and the new build gave byte-identical `GET /media` responses (251,815 bytes). A new build against an empty database answered `503` with `Retry-After: 5` and `/status` reported `starting` while it hashed.
