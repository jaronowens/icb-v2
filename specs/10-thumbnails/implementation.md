# Implementation Plan: Thumbnails

Implements `specs/10-thumbnails/spec.md`. Builds on `sharp` and the perceptual hash job (`specs/07-background-perceptual-hash/`) and the `/media` responses (`specs/06-media-route/`, `specs/09-tags/`).

## Decisions

| Topic | Decision |
| --- | --- |
| Job order | The thumbnail job runs after the perceptual hash job goes idle. The perceptual hash job gets an `onIdle` callback, called in its loop's `finally` when no pass is pending, whether the loop succeeded or failed. `bin/www.ts` connects it to `thumbnailJob.trigger()`. `POST /media` doesn't trigger the thumbnail job directly: it triggers the perceptual hash job as before, and the thumbnail job follows. On a warm restart, the perceptual hash pass handles 0 rows, goes idle straight away, and the thumbnail pass then runs a cheap `stat` sweep. _Decided while planning: the spec first had both jobs start together._ |
| Skipping undecodable images | The job's query excludes `Media.perceptualHash = 'none'`. Rows with `NULL` (not hashed yet, or a read failure) are included. Because of the job order, on a fresh database the perceptual hash pass has already marked the undecodable images before the thumbnail pass starts. The on-demand fallback doesn't check `'none'`: it tries the decode and redirects if it fails. _Decided while planning._ |
| Settings and `previewURL` | `service/thumbnailSettings.ts` (new) holds `THUMBNAIL_TYPES`, `THUMBNAIL_SIZE`, `THUMBNAIL_SIZES`, `LONG_SIDE_RATIO = 3`, `thumbnailRelativePath(hex, size)` (`<aa>/<hex>-<size>.webp`) and `previewURL(imageURL, imageHash, extension)`. They're pure functions with no `sharp` import, the same split as `perceptualHashSettings.ts`, so `mediaService` and the fallback can import them without loading `sharp`. |
| Thumbnail service is a factory | `createThumbnailService({ dir, concurrency })` in `service/thumbnailService.ts` returns `{ dir, pathFor(hex, size), ensure(hex, size, source, priority), stats }`. One instance is shared by the fallback and the job, so they share the in-flight map and the queue. `stats.generated` counts successful `sharp` runs, so tests can check deduplication without spying on `sharp`. |
| `createApp` option | `createApp` takes `thumbnails: ThumbnailService`, which is required, and `thumbnailJob?: ThumbnailJob`. The spec describes a `thumbnailDir` option. A service instance is used instead, because `bin/www.ts` has to give the same instance to the job. `createApp` mounts `express.static(thumbnails.dir)`. |
| Cache folder | `bin/www.ts` resolves it as `process.env.THUMBNAIL_DIR \|\| './db/thumbnails'`. The service creates subfolders when it needs them (`mkdir { recursive: true }` before each write). It never creates the root folder until a thumbnail is written. |
| Test cache folder | `createTestApp` makes a service rooted at `<os.tmpdir()>/icb-test-<pid>/thumbnails-<n>`, where `n` counts up for each call, and returns it as `thumbnails`. A root `after` hook added to `test/helpers/setup.ts` deletes `icb-test-<pid>` once, so existing suites need no cleanup code. |
| Priority queue | A small limiter in `util/limiter.ts`: `createLimiter(concurrency)` returns `run(fn, priority: 'request' \| 'background')`. There are two FIFO queues, and a free slot always takes from `request` first. There's no new dependency: `p-limit` has no priorities, and this is about 30 lines. |
| In-flight map vs priority | When a request asks for a thumbnail that the job has queued but not started, the request waits on the job's promise, and the job stays at background priority. Raising its priority would need a cancellable queue entry. This case is rare (one tile, briefly) and only adds latency, so it isn't handled. |
| Metadata / orientation | `orientedSize(meta)` returns `meta.autoOrient` when present (sharp 0.35.5 provides it: checked in `node_modules/sharp/lib/index.d.ts`). Otherwise it swaps for `orientation` 5–8. |
| libvips concurrency | The perceptual hash workers call `sharp.concurrency(1)` and `sharp.cache(false)`. libvips is shared across the process, so that may apply to the main thread's thumbnail pipelines too. That's acceptable: each thumbnail is then single-threaded, and `THUMBNAIL_CONCURRENCY = 2` sets how many run in parallel. Don't call `sharp.concurrency` in the thumbnail service. Do call `sharp.cache(false)` there, because each source is decoded once. |
| Error types | `ensure` rejects with a `ThumbnailError` that has `kind: 'read' \| 'decode'`. It reads the file with `fs.readFile` first, then runs `sharp` on the buffer, the same split as `perceptualHashWorker.handleRequest`. |
| Fallback lookup | New `getThumbnailSource(db, imageHash)` in `repository/media.ts`: `SELECT Local.source, Local.extension, Local.imageURL FROM Media JOIN Local ON Local.id = Media.sourceID WHERE Media.imageHash = ? AND Media.isMounted = 1`. It uses the existing unique index on `Media.imageHash`. |
| Fallback DB gate | `thumbnailFallback` checks `req.app.locals.dbStatus` itself and answers `503` with `Retry-After: 5`, the same as `requireDatabase`. It's mounted outside `requireDatabase`, so cache hits never wait on the database. Reuse the `requireDatabase` response logic if it can be pulled out cleanly. Otherwise duplicate the three lines. |
| Methods | The fallback handles `GET` and `HEAD`. Other methods fall through to the app's 404. `express.static` already ignores non-GET/HEAD requests. |
| Mount order | In `app.ts`: `/thumbnails` static, then the fallback, then the directory mounts. `isValidDirectoryName` rejects `thumbnails`, so a directory can't take that path first. |
| Status shape | `/status` adds `thumbnails: { state, done, total }`, defaulting to the idle status when there's no job. The existing exact-match assertions in `status.test.ts` and `errors.test.ts` gain the new key. |
| Migration 5 | `ALTER TABLE Local DROP COLUMN previewURL`. SQLite is 3.52: checked with `select sqlite_version()`. `CURRENT_VERSION` becomes 5. |

---

## Steps

Steps 1 and 2 touch different files and run in parallel. Step 3 runs next, then Step 4: both need Step 2's service interface (below), and Step 4 uses the app option and test helper that Step 3 adds. Step 5 is a final check over everything.

### Shared interfaces (fixed before any step starts)

```ts
// service/thumbnailSettings.ts
export const THUMBNAIL_TYPES = ['jpg', 'jpeg', 'png', 'webp'];
export const THUMBNAIL_SIZE = 900;
export const THUMBNAIL_SIZES = [900];
export const LONG_SIDE_RATIO = 3;
export const thumbnailRelativePath = (hex: string, size: number) => `${hex.slice(0, 2)}/${hex}-${size}.webp`;
export const previewURL = (imageURL: string | null, imageHash: string | null, extension: string | null): string | null;

// service/thumbnailService.ts
export type ThumbnailPriority = 'request' | 'background';
export class ThumbnailError extends Error { kind: 'read' | 'decode' }
export interface ThumbnailService {
    dir: string;
    pathFor(hex: string, size: number): string;               // absolute path in dir
    ensure(hex: string, size: number, source: string, priority: ThumbnailPriority): Promise<string>; // resolves to pathFor(...)
    stats: { generated: number };
}
export const createThumbnailService: (opts: { dir: string, concurrency?: number }) => ThumbnailService;
export const thumbnailDimensions: (width: number, height: number, size: number) => { width: number, height: number };
export const orientedSize: (meta: sharp.Metadata) => { width: number, height: number };
export const concurrencyFromEnv: () => number;              // THUMBNAIL_CONCURRENCY, default 2

// service/thumbnailJob.ts
export interface ThumbnailJob { trigger(): void; status(): JobStatus; whenIdle(): Promise<void>; }
export const createThumbnailJob: (db, thumbnails: ThumbnailService) => ThumbnailJob;
```

`JobStatus` is the existing `PerceptualHashStatus` shape (`{ state, done, total }`). Re-export it under a neutral name, along with `IDLE_STATUS`, from a small `service/jobStatus.ts`, and have `perceptualHashService.ts` import from there.

### Step 1: Compute `previewURL` and drop the stored column

**Files:** `service/thumbnailSettings.ts` (new), `repository/schema.ts`, `repository/local.ts`, `repository/media.ts`, `entity/localFileNode.ts`, `entity/mediaNode.ts`, `service/localFileService.ts`, `service/mediaService.ts`, `service/startupService.ts`, plus the tests below.

1. **`service/thumbnailSettings.ts`:** add the exports above. `previewURL`:
   - Returns `null` if `imageURL` is `null` (unmounted media).
   - Returns `imageURL` if the extension isn't in `THUMBNAIL_TYPES`, or if the hash doesn't start with `sha256:`. An outdated hash should never produce a broken URL.
   - Otherwise returns `` `${BASE_URL}/thumbnails/${thumbnailRelativePath(hex, THUMBNAIL_SIZE)}` ``.

   Import `BASE_URL` from `localFileService.ts`. Check that this doesn't create an import cycle. If it does, move `BASE_URL` into the settings file and re-export it from `localFileService.ts`.
2. **Migration 5** in `repository/schema.ts`: `ALTER TABLE Local DROP COLUMN previewURL`, and bump `CURRENT_VERSION` to 5. Add a comment in the style of the existing ones.
3. **Stop storing `previewURL`:**
   - Remove it from `localFileNode`, `initializeLocalNode`, the `INSERT` in `insertLocalNodes` (13 placeholders become 12), and both `UPDATE`s in `repository/local.ts` (lines 59 and 68).
   - Remove `Local.previewURL` from the `SELECT`s in `repository/media.ts` (lines 137 and 167).
   - In `getLocalNodesForMedia`, replace `previewURL` with `imageHash`.
4. **`service/mediaService.ts`:**
   - `toMediaNode` sets `previewURL: previewURL(row.imageURL, row.imageHash, row.extension)`.
   - Wherever `MediaFile` entries are built for `GET /media/:id`, map each file row the same way, using that file's own `imageHash`. Don't return `imageHash` in `MediaFile`: its shape doesn't change.
   - `unmountedNode` already sets `null`.
5. **`entity/mediaNode.ts`:** update the comments on `previewURL`: "a thumbnail for jpg/jpeg/png/webp, otherwise the same as imageURL".
6. **`service/startupService.ts`:** `isValidDirectoryName` returns false for `thumbnails`. Add a comment explaining that the path is reserved.
7. **Tests:**
   - `test/unit/schema.test.ts`: migration 5 keeps every row, and `Local` has no `previewURL` column (`PRAGMA table_info(Local)`). Update any check that expects a version of 4.
   - New `test/unit/thumbnailSettings.test.ts`: `previewURL` gives the thumbnail form for each of the four types. For gif, mp4 and webm it gives `imageURL`. For a non-sha256 hash it gives `imageURL`. With a `null` `imageURL` it gives `null`. `thumbnailRelativePath` takes the first two hex characters as the folder.
   - `test/integration/media.test.ts`: `previewURL` has the thumbnail form for decodable fixtures and equals `imageURL` for gif and mp4, in both `GET /media` and `GET /media/:id` `files[]`. The "serves previewURL" check belongs to Step 3: the route doesn't exist yet.
   - `test/unit/startupService.test.ts`: a directory named `thumbnails` is skipped like any other invalid name.
   - `test/unit/rekey.test.ts`: check that it still builds its version-2 database with its own `previewURL` column, and that migrating it all the way to version 5 passes.

**Done when:** `npm test` passes, and `npm run build` (or whichever script runs `tsc`) passes.

### Step 2: The thumbnail service

**Files:** `util/limiter.ts` (new), `service/thumbnailService.ts` (new), `service/jobStatus.ts` (new), `service/perceptualHashService.ts` (only the import of `IDLE_STATUS` and the status type), `test/unit/limiter.test.ts` (new), `test/unit/thumbnailService.test.ts` (new), `test/fixtures/images/` (new EXIF fixture), `test/fixtures/README.md`.

1. **`util/limiter.ts`:** `createLimiter(concurrency)` returns `{ run<T>(fn: () => Promise<T>, priority): Promise<T>, active(): number, queued(): number }`. Rejections pass through, and a rejected task still frees its slot.
2. **`thumbnailDimensions(width, height, size)`:** follows the spec's formula, with `LONG_SIDE_RATIO`. It's a pure function.
3. **`orientedSize(meta)`:** see Decisions.
4. **`createThumbnailService({ dir, concurrency = concurrencyFromEnv() })`:**
   - Calls `sharp.cache(false)` once, when the module loads.
   - `inFlight: Map<string, Promise<string>>`, keyed by `` `${hex}-${size}` ``.
   - `ensure(hex, size, source, priority)`:
     1. If `size` isn't in `THUMBNAIL_SIZES`, or `hex` doesn't match `/^[0-9a-f]{64}$/`, throw. This is a programming error: callers validate first.
     2. If the key is in flight, return the existing promise.
     3. Otherwise start `limiter.run(() => generate(...), priority)`, store it, and delete it in `finally`.
   - `generate`:
     1. If `pathFor` already exists, return it. This covers a file that the job, or another request, finished between a caller's check and this point.
     2. `readFile(source)`. On failure, throw `ThumbnailError('read')`.
     3. Read the metadata and run the pipeline from the spec into `<final>.<randomUUID()>.tmp`. Any `sharp` error becomes `ThumbnailError('decode')`.
     4. `mkdir(dirname, { recursive: true })` before writing.
     5. `rename(temp, final)`. On `EPERM`, `EEXIST` or `EACCES`, check whether the final file exists. If it does, delete the temp file and treat this as success. Otherwise rethrow.
     6. In a `finally`, delete the temp file if it's still there, ignoring `ENOENT`.
     7. Increment `stats.generated` only when its own rename succeeds.
5. **`service/jobStatus.ts`:** move `IDLE_STATUS` and the status type here. Update the imports in `perceptualHashService.ts` and `routes/status.ts`. Keep the current names exported from `perceptualHashService.ts` too, so nothing else breaks.
6. **EXIF fixture:** `test/fixtures/images/exif-rotated.jpg`, about 120×80 pixels, with `orientation: 6`. Make it with a throwaway `sharp` script in the scratchpad: `sharp({ create: ... }).composite(...).jpeg().withMetadata({ orientation: 6 })`. Put a marker in one corner so it's obvious which way up it is. List it in `test/fixtures/README.md`.
   - **Check the effect on existing tests:** a new fixture changes the Media counts in `startupService.test.ts`, `media.test.ts` and elsewhere. Update those counts in the same commit, and say so in `progress.md`.
7. **Tests:**
   - `limiter.test.ts`: never more than `concurrency` tasks run at once, request tasks queued after background tasks start first, FIFO order holds within a priority, and a rejected task frees its slot.
   - `thumbnailService.test.ts`, using a temp folder for each test and images made with `sharp({ create })` in that folder:
     - **`thumbnailDimensions`:** 3000×2000 → 1350×900, 2000×3000 → 900×1350, 1000×20000 → 135×2700, 600×400 → 600×400, 1×5000 → at least 1×1 with the long side ≤ 2700.
     - **`orientedSize`:** swaps for orientation 6, and doesn't for orientation 1.
     - **`ensure` on a real image:** writes WebP at the computed size (read back with `sharp().metadata()`). The path matches `pathFor`. A second call doesn't generate again (`stats.generated === 1`).
     - **Two concurrent `ensure` calls for the same key:** `stats.generated === 1`, and both resolve to the same path.
     - **`exif-rotated.jpg`:** the output's width and height are swapped compared with the stored pixels (80×120).
     - **Failures:** `not-an-image.png` rejects with `kind: 'decode'`, a missing path rejects with `kind: 'read'`, and neither leaves a file or a `.tmp` behind.
     - **Lost rename race:** if the final file already exists when `rename` runs, `ensure` still succeeds. Simulate this by writing the final file between the metadata read and the rename, or by passing a test hook. Keep any hook internal.

**Done when:** the new unit tests pass, the existing suite passes with the updated counts, and `tsc` passes.

### Step 3: Serving (`/thumbnails`)

**Depends on Step 2. Files:** `routes/thumbnails.ts` (new), `repository/media.ts` (only `getThumbnailSource`), `app.ts`, `test/helpers/index.ts`, `test/helpers/setup.ts`, `test/integration/thumbnails.test.ts` (new), `test/integration/media.test.ts` (only the "serves previewURL" check).

1. **`getThumbnailSource`:** see Decisions.
2. **`routes/thumbnails.ts`:** exports `thumbnailFallback(req, res, next)`:
   - Methods other than `GET` and `HEAD` call `next()`.
   - Match `req.path` against the spec's regex. On no match, a folder that isn't `hex.slice(0, 2)`, or a size not in `THUMBNAIL_SIZES`, call `next()`, which ends in the app's `404`.
   - If `dbStatus !== 'ready'`, answer `503`. See Decisions.
   - Look up the row with `getThumbnailSource(db, 'sha256:' + hex)`. If there's no row, or the extension isn't in `THUMBNAIL_TYPES`, answer `404` (via `createError` and `next`, so the response uses the app's error format).
   - Call `thumbnails.ensure(hex, size, source, 'request')`, then `res.sendFile(path, { maxAge: '1y', immutable: true })`.
   - On `ThumbnailError` `decode`: `res.set('Cache-Control', 'no-cache').redirect(302, row.imageURL)`. On `read`: `404`. Anything else goes to `next(err)`.
   - The handler is `async`. Express 5 passes rejected promises to the error handler.
3. **`app.ts`:**
   - Add `thumbnails` and `thumbnailJob` to `AppOptions` and to the doc comment.
   - Set `app.locals.thumbnails` and `app.locals.thumbnailJob`.
   - Mount `express.static(thumbnails.dir, { maxAge: '1y', immutable: true, index: false, fallthrough: true })`, then `thumbnailFallback`, both at `/thumbnails`, before the directory mounts.
4. **`test/helpers/index.ts`:**
   - `createTestApp` gains `thumbnails` (a factory `(dir) => ThumbnailService`, defaulting to `createThumbnailService({ dir, concurrency: 2 })`) and `thumbnailJob` (a factory `(db, thumbnails) => ThumbnailJob`, off by default, like `perceptualHashing`).
   - It returns `{ app, db, job, thumbnails, thumbnailJob }`.
   - It exports `testThumbnailDir()`.
   - `test/helpers/setup.ts` gains a root `after` hook that does `rm(<tmp>/icb-test-<pid>, { recursive: true, force: true })`. Check that `.mocharc.json` loads `setup.ts` as a root-hook-capable file. If it doesn't, use `exports.mochaHooks = { afterAll }`.
5. **Tests in `test/integration/thumbnails.test.ts`:** cover every fallback case in the spec's Tests section:
   - First request generates (`stats.generated` goes up, `Content-Type: image/webp`, `Cache-Control` contains `immutable`).
   - Second request is a static hit (`stats.generated` unchanged, file mtime unchanged).
   - Two concurrent requests give `generated === 1`.
   - `404`s: malformed path, wrong folder, unknown size, unknown hash, unmounted hash, gif hash, mp4 hash.
   - `not-an-image.png` gives `302` to its `imageURL` with `Cache-Control: no-cache`, and no file is written.
   - A source deleted after sync gives `404`. Sync from a temp copy of one fixture, then delete it.
   - `503` while `ready` is pending (use `deferred`).
   - `HEAD` works.
   - No `.tmp` files are left in the folder after the suite (check in an `after` hook).
6. **`test/integration/media.test.ts`:** every `previewURL` in `GET /media` answers `200` with `image/webp`, or with the original type for gif and mp4.

**Done when:** the new suite and the full suite pass, and `tsc` passes.

### Step 4: Background job and status

**Depends on Step 2. Files:** `service/thumbnailJob.ts` (new), `repository/media.ts` (only `getMediaNeedingThumbnail`), `service/perceptualHashService.ts` (`onIdle`), `routes/status.ts`, `bin/www.ts`, `test/unit/thumbnailJob.test.ts` (new), `test/integration/status.test.ts`, `test/integration/errors.test.ts`, `test/unit/perceptualHash.test.ts` (`onIdle` cases).

**Uses Step 3's wiring:** Step 3 has already added the `thumbnailJob` option to `createApp` and the `thumbnailJob` parameter to `createTestApp`. This step only uses them.

1. **`getMediaNeedingThumbnail(db, types)`:** returns `Media.id`, `Media.imageHash` and `Local.source`, joined on `sourceID`, for rows where `isMounted = 1`, `Local.extension IN (types)`, `(Media.perceptualHash IS NULL OR Media.perceptualHash != 'none')` and `imageHash LIKE 'sha256:%'`, ordered by `Media.id`.
2. **`perceptualHashService.ts`:**
   - Add `onIdle?: () => void` to `JobOptions`.
   - Call it in the loop's `finally`, after `loop = null`, and only when no pass is pending (that is, when it won't re-trigger). Wrap the call in `try/catch` so a throwing callback can't break the job.
   - Test it: it's called once after a pass with no new trigger, once (not twice) when a trigger arrives mid-pass, and after a failed pass.
3. **`service/thumbnailJob.ts`:**
   - Copy the trigger, pending and loop structure from `createPerceptualHashJob`, including `whenIdle`. The loop is about 30 lines, and pulling out a shared helper would mean changing a working job for little benefit. Note the duplication in a comment.
   - **Each pass:**
     1. Query the rows.
     2. Filter to the rows whose `pathFor(hex, THUMBNAIL_SIZE)` doesn't exist, using `stat` in parallel batches of about 50.
     3. Set `status = { state: 'running', done: 0, total: missing.length }`.
     4. Call `thumbnails.ensure(hex, THUMBNAIL_SIZE, source, 'background')` for each one. Start them all at once and let the limiter queue them.
     5. Count successes and failures towards `done`, log every 100, and log each failure with its kind.
     6. When there's nothing missing, go straight to idle.
4. **`routes/status.ts`:** add `thumbnails: req.app.locals.thumbnailJob?.status() ?? IDLE_STATUS`.
5. **`bin/www.ts`:**
   - Create `thumbnails = createThumbnailService({ dir: process.env.THUMBNAIL_DIR || path.join('db', 'thumbnails') })` and `thumbnailJob = createThumbnailJob(dbConnection, thumbnails)`.
   - Pass `onIdle: () => thumbnailJob.trigger()` to `createPerceptualHashJob`.
   - Pass both to `createApp`.
   - Update the comment block above it.
6. **Tests:**
   - `thumbnailJob.test.ts`, using the synced fixtures app and a test thumbnail folder:
     - After one pass, every decodable fixture has a file, and `not-an-image.png`, the gif and the mp4 have none.
     - A second pass generates nothing (`stats.generated` unchanged) and goes straight to idle.
     - A trigger mid-pass runs exactly one more pass. Count passes with a counter, the same way the perceptual hash tests do.
     - A row with `perceptualHash = 'none'` is skipped, even when its file decodes. Set it by hand on a good image to prove the filter is what skips it.
     - `/status` reports `running` and then `idle` with the right counts.
     - **Order:** with the perceptual hash job wired up the way `bin/www.ts` does it, the thumbnail pass starts only after the perceptual hash pass ends.
   - `status.test.ts` and `errors.test.ts`: add `thumbnails: { state: 'idle', done: 0, total: 0 }` to the exact-match bodies.

**Done when:** the new tests and the full suite pass, and `tsc` passes.

### Step 5: Verify against real data and tune quality (main session)

1. `npm test` and `tsc` across everything.
2. **Fresh run against `highly-rated`:** move `db/` aside, then start the server. Record in the "Measurements" section below:
   - How long until `/status` reports the database ready.
   - How long the perceptual hash pass took, and the confirmation that the thumbnail pass started after it.
   - How long the thumbnail pass took, how many it made, and how many failed.
   - The total size of the originals against the total size of `db/thumbnails/`.
   - A few `/media` and cache-hit `/thumbnails` response times taken during the thumbnail pass.
3. Restart and confirm that the thumbnail pass generates 0.
4. **On-demand check:** delete `db/thumbnails/`, restart with the thumbnail job not yet reached (or with `THUMBNAIL_CONCURRENCY=1`), and load a few `previewURL`s in a browser. Each one loads.
5. **Quality samples:** pick three or four line-art images from `highly-rated`, and write sample thumbnails to the scratchpad at quality 80, quality 85, and quality 80 with `smartSubsample: true`. Give the user the folder's full path to compare them. Record their choice, and change the pipeline if needed. Note that changing the quality doesn't change the path, so the cache would have to be cleared by hand. Mention that in the summary.
6. **README:** mark Thumbnails ✅.
7. Write `summary.md`.

---

## Subagents

Tracked in real time in `specs/10-thumbnails/progress.md`, with the model, start and end times, duration and token count for each task, plus a final total. When everything is done, the summary goes in `specs/10-thumbnails/summary.md`, including bugs found and fixed.

| Task | Model | Effort | Why | Runs |
| --- | --- | --- | --- | --- |
| Step 1: compute `previewURL`, migration 5 | Sonnet | medium | Mechanical changes across many files, with clear patterns to follow. | In parallel with Step 2 |
| Step 2: thumbnail service and limiter | Opus | high | The hardest part: concurrency, the priority queue, atomic writes with Windows rename quirks, and orientation. Bugs here are subtle. | In parallel with Step 1 |
| Step 3: `/thumbnails` fallback and app wiring | Sonnet | medium | Straightforward Express code against a fixed interface, and many test cases. | After Steps 1 and 2 are merged |
| Step 4: background job, `onIdle`, status | Sonnet | high | Copies the perceptual hash job's loop, but the `onIdle` timing and the order test need care. | After Step 3 (see below) |
| Step 5: verification and quality | Main session | — | Needs the user's real folder, a browser check, and their decision on quality. | Last |

**Running Steps 3 and 4 one after the other:** Step 4 builds on the app option and test helper that Step 3 adds. Step 3 is small, so running them in sequence costs little and avoids merging two edits to the same files. Steps 1 and 2 run in parallel because their files don't overlap.

**How the subagents work:**
- Each subagent gets: the spec, this plan, its step, the shared interfaces, and the instruction to run only its own tests until the main session merges.
- Every subagent works in the main working tree. Because Steps 1 and 2 share no files, a worktree isn't needed. The one shared file is the fixture count in Step 2's new EXIF fixture: Step 1 shouldn't hard-code fixture counts in new tests.
- The main session runs the full suite after each merge point (after Steps 1 and 2, after Step 3, after Step 4) and records failures and fixes in `progress.md`.

---

## Risks

- **Fixture count changes:** adding `exif-rotated.jpg` changes Media counts in several existing tests. Step 2 owns those updates.
- **Windows file locks:** antivirus or the search indexer can briefly lock a freshly written file, so `rename` can fail. This is covered by the "final exists" check. If it fails with neither file present, the error is rethrown and the request gets `500`. The next request tries again, because nothing was cached.
- **First load of a cold grid:** with an empty cache and the thumbnail job still waiting on perceptual hashing, a full grid generates thumbnails 2 at a time. Each one costs roughly the decode time of its original. That's acceptable on a first run, and the job fills in the rest soon after.
- **Orphaned thumbnails:** changing `THUMBNAIL_SIZE` or the quality leaves old files behind. There's no cleanup until media deletion is built (see the spec's "Out of scope").

## Measurements

These runs used the real `directories.json` (`highly-rated`, 670 Media rows), a scratch database and a scratch cache folder, wired the same way as `bin/www.ts`. The real `db/` wasn't touched. Measured on 2026-11-24.

**Fresh run** (new database, empty cache):

| Event | Time |
| --- | --- |
| Database ready (`/status`) | 2.7 s |
| `/media` returns 670 entries | 2.8 s |
| Perceptual hash pass ends (652 images hashed) | 12.2 s |
| Thumbnail job triggered by `onIdle` | 12.2 s, right after the perceptual hash pass |
| Thumbnail pass ends (652 made, 0 failed) | 54.8 s, so the thumbnail phase took 42.6 s (about 65 ms per image at concurrency 2) |

- **Response times during the thumbnail pass:** `/media` took 9–18 ms, and a cache-hit `/thumbnails` request took 2–4 ms.
- **Every `previewURL` answers:** all 670 gave `200`, including the 18 gif and video rows, which point at the original file.

**Sizes:**

| | Files | Size |
| --- | --- | --- |
| Originals (jpg/jpeg/png/webp) | 652 | 699.9 MB |
| Thumbnails | 652 | 45.2 MB, **6.5%** of the originals (about 69 KB each) |

**Restart** (same database and cache): the perceptual hash pass handled 0 and the thumbnail pass needed 0. Both went idle within 0.2 s.

**On-demand check** (empty cache, no background job): 24 grid tiles were requested at once.
- All 24 gave `200`, finishing in 1.8 s. The first tile took 119 ms and the median was 1.1 s, because they're made 2 at a time.
- Requesting the same grid again took at most 22 ms, with no new thumbnails made.

**Quality samples:** the 4 largest PNGs in `highly-rated`, at the 900 px short side:

| Image | q80 | q85 | q80 + `smartSubsample` |
| --- | --- | --- | --- |
| 1325.png | 44 KB | 62 KB | 46 KB |
| 4655.png | 73 KB | 88 KB | 77 KB |
| 3215.png | 75 KB | 90 KB | 78 KB |
| 4782.png | 40 KB | 53 KB | 42 KB |

**Decision:** the user compared the samples and chose quality 80, which the pipeline already uses.
