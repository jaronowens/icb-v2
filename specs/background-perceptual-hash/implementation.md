# Implementation Plan: sha256 identity, background perceptual hashes with `sharp`

Implements `specs/background-perceptual-hash/spec.md`. Builds on persistence (`specs/persistence/`) and the `/media` work (commit `cafb27c`).

## Decisions

| Topic | Decision |
| --- | --- |
| Order of work | Measure first (Step 1). The resize and carryover decisions change the code in later steps, and the golden hashes have to be recorded while `image-hash` is still installed. |
| Where the job lives | `service/perceptualHashService.ts` exports `createPerceptualHashJob(db)`. `bin/www.ts` creates it and passes it to `createApp`, which stores it on `app.locals.perceptualHashing`. Tests only create a job when they want one, so the existing suites don't start worker threads. |
| Worker lifetime | A new pool for each pass, terminated when the pass ends. An idle server has no extra threads, and nothing keeps the process alive after the last pass. Starting a few workers costs much less than one pass. |
| Why workers even with `sharp` | `sharp` decodes off the main thread, but blockhash is plain JS that loops over every pixel. On a 2605×4096 fixture that's about 10 million pixels, too slow to run on the main thread. If Step 1 adopts the resize, the main-thread cost would become small. Record the blockhash time in Step 1 anyway, but keep the workers: they're what the spec promises, and they cost little. |
| Pool size | One less than libuv's threadpool size (`UV_THREADPOOL_SIZE`, default 4), capped at `os.availableParallelism() - 1`, and overridden by the `PERCEPTUAL_HASH_WORKERS` env var. Never more workers than files in the pass. _Changed during verification: the plan said `availableParallelism() - 1`. See "Worker count" under Measurements._ |
| Loading the worker in tests | Production runs compiled `build/service/perceptualHashWorker.js`. Mocha runs `.ts` source through `tsx/cjs`, which only registers in the main thread. So if `__filename` ends in `.ts`, start the worker from the `.ts` file with `execArgv: ['--require', 'tsx/cjs']`. Checked during planning: a `.ts` worker started this way works under this repo's mocha + tsx. |
| Transactions | The job writes with `withTransaction` (`util/transaction.ts`), because it runs at the same time as `POST /media` on the shared connection. Startup and the re-key step keep their own `BEGIN`s, because they run before `/media` opens. |
| Read vs decode errors | The worker reads the file with `fs.readFile` first, then decodes the buffer with `sharp`. A read error leaves `NULL` (retried next pass); a `sharp` error stores `none`. Reading first keeps the two kinds of error apart without parsing `sharp`'s error messages. |
| `computeFileHash` signature | Drops the `extension` parameter, since every file is now hashed the same way. |

---

## Step 1: Measure (`sharp`, `blockHash`, golden hashes)

1. `npm install sharp`. Keep `image-hash` for now.
2. **`service/blockHash.ts` (new):** copy `node_modules/image-hash/lib/block-hash.js` and convert it to TypeScript. Keep the logic exactly as it is, including both `method` branches (the job uses method 2, `bmvbhash`). Put the MIT notice from `node_modules/image-hash/LICENSE` in a header comment.

   ```ts
   type ImageData = { width: number, height: number, data: Uint8Array | Buffer };
   export default function blockhash(imgData: ImageData, bits: number, method: 1 | 2): string
   ```
3. **Transparent fixture:** add `test/fixtures/images/transparent-corner.png`, about 64×64, with an opaque shape and one fully transparent quadrant. Generate it once with a throwaway `sharp` script in the scratchpad, using `create` plus `composite`. List it in `test/fixtures/README.md`.
4. **`specs/background-perceptual-hash/tools/compare-decoders.ts` (new):** usage is `npx tsx specs/background-perceptual-hash/tools/compare-decoders.ts <folder> [--pairs]`.
   - For each jpg/jpeg/png/webp, compute:
     - **A:** `image-hash`'s `imageHash(file, 16, true)`
     - **B:** `sharp` without resize, then `blockHash`
     - **C:** `sharp` resized with `.resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })`, then `blockHash`. Put the resize before `.toColourspace(...)`.
   - Print per file: d(A,B), d(A,C), and the time for A, B and C. Also time `blockHash` on its own for B and C.
   - Print a summary: the number of files with d = 0, the maximum and mean of each distance, and the mean time of each pipeline.
   - `--pairs`: also compute the pairwise distances under pipelines B and C and print the closest pairs, as `specs/near-match-duplicates/tools/pairwise-distances.js` does. Reuse its pairing and Hamming code.
5. Run the tool on `test/fixtures/images`, `duplicates-test` (with `--pairs`) and `highly-rated`.
6. **Record and decide** in a "Measurements" section at the end of this file:
   - **Resize:** adopt C if, in `duplicates-test` under C, all 19 alternate pairs from the near-match ground truth are within 40 and the closest other pair is still well above 40 (it's 68 today). Otherwise use B.
   - **Carryover:** keep the migration's `UPDATE` (Step 3) only if the chosen pipeline has d(A, chosen) = 0 on every file in all three folders. Otherwise remove it.
   - **JPEG tolerance:** the largest d(A, chosen) seen on a fixture JPEG or WebP, used by the golden-hash test in Step 9.
7. **Golden hashes:** add `test/fixtures/goldenHashes.ts` with A for every decodable fixture, including `transparent-corner.png`:

   ```ts
   export const GOLDEN_PHASH16: Record<string, string> = { ... };
   ```

   Generate it with a one-off run of the tool, using a `--golden` flag that prints the object.

Commit Step 1 on its own (measurements, tool, `blockHash`, fixture, golden hashes), so the decisions are on record before the code that depends on them.

## Step 2: Identity hash (`service/hashService.ts`)

- Remove the `image-hash` import, `PERCEPTUAL_TYPES`, `HASH_BITS` and `PHASH_PREFIX`. They move to Step 5.
- `computeFileHash(filePath)` returns `` `sha256:${await sha256File(filePath)}` ``.
- `isCurrentHash(hash)` returns `hash.startsWith(SHA256_PREFIX)`. Update its comment: any `phash` hash is now out of date.
- Export `sha256File` for the re-key step.
- `hashLocalNodes` stays as it is. Its concurrency of 8 now overlaps file reads, which is what it's actually for.
- Callers: `hashLocalNodes` calls `computeFileHash(node.source)`. `test/integration/mediaPost.test.ts` imports `computeFileHash`, so update its call too.

## Step 3: Schema migration 3 (`repository/schema.ts`)

Set `CURRENT_VERSION = 3` and add:

```ts
// 2 -> 3: perceptual hashes move off the identity hash into their own column (specs/background-perceptual-hash)
3: async (db) => {
    await db.run('ALTER TABLE Media ADD COLUMN perceptualHash TEXT');
    // carryover: only if Step 1 found sharp's hashes identical to image-hash's
    await db.run(`UPDATE Media SET perceptualHash = imageHash WHERE imageHash LIKE 'phash16:%'`);
},
```

If Step 1 dropped the carryover, delete the `UPDATE` and its comment. In that case the comment should say that every image is recomputed once in the background after this migration.

No index is needed on `perceptualHash`: the job's query (Step 5) filters on the column without an index, and near-match reads every row anyway.

## Step 4: Re-key step (`service/rekeyService.ts`, new)

```ts
/**
 * One-time upgrade from perceptual identity hashes to sha256 (specs/background-perceptual-hash).
 * Gives every Local row that still has a phash identity hash its sha256. Each Media row keeps its id
 * under the sha256 of its lowest-id file, and files with different bytes are unlinked
 * so the normal sync steps give them their own Media rows.
 * Does nothing once no `phash` Local rows remain.
 */
const rekeyLegacyHashes = async (db): Promise<void>
```

1. `SELECT id, source, mediaID FROM Local WHERE imageHash LIKE 'phash%' ORDER BY id`. If there are no rows, return. This is the single query every later start runs.
2. sha256 each row with `sha256File`, 8 at a time (the same batching as `hashLocalNodes`). If a file can't be read, leave its row alone and log one warning. Missing files are deleted by the directory sync right after, and other read errors are retried on the next start, because their hash still isn't current.
3. In one transaction (`BEGIN` / `COMMIT` / `ROLLBACK`, as `syncDirectory` does):
   - Group the hashed rows by `mediaID`, keeping id order.
   - **`mediaID = -1`:** `UPDATE Local SET imageHash = ? WHERE id = ?`.
   - **For each Media id M:** let `S` be the first row's sha256.
     - If no Media row other than M already has `imageHash = S` (`SELECT id FROM Media WHERE imageHash = ? AND id != ?`), run `UPDATE Media SET imageHash = ? WHERE id = ?`.
     - For each row in the group: if M was re-keyed and the row's sha256 is `S`, update only its `imageHash`. Otherwise set `imageHash = <its sha256>, mediaID = -1`.
   - Leave `size` and `mtimeMs` alone. If a file changed since the last start, `syncDirectory` still sees the size/mtime difference, re-hashes it, and re-links it.
4. Log `Re-keyed <n> media rows to sha256, split off <k> files`.

The `Media.imageHash UNIQUE` constraint is the safety net here: a bug that tries to create two rows with the same key fails the transaction instead of corrupting data.

**`service/startupService.ts`:** call `await rekeyLegacyHashes(connection)` straight after `migrate(connection)`, and add it to the order comment.

## Step 5: Background job

### `service/perceptualHashWorker.ts` (new)

```ts
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import blockhash from './blockHash';
import { HASH_BITS, RESIZE } from './perceptualHashSettings';

sharp.concurrency(1);   // the pool provides the parallelism
sharp.cache(false);     // each file is read once

type Request = { id: number, source: string };
type Response = { id: number, hash: string } | { id: number, error: 'read' | 'decode', message: string };

parentPort.on('message', async ({ id, source }: Request) => {
    let buffer: Buffer;
    try {
        buffer = await readFile(source);
    } catch (err) {
        return parentPort.postMessage({ id, error: 'read', message: err.message });
    }
    try {
        let image = sharp(buffer);
        if (RESIZE) image = image.resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true });
        const { data, info } = await image.toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' })
            .toBuffer({ resolveWithObject: true });
        if (info.channels !== 4) throw new Error(`expected 4 channels, got ${info.channels}`);
        parentPort.postMessage({ id, hash: blockhash({ width: info.width, height: info.height, data }, HASH_BITS, 2) });
    } catch (err) {
        parentPort.postMessage({ id, error: 'decode', message: err.message });
    }
});
```

### `service/perceptualHashSettings.ts` (new)

The worker and the job both import it, so neither has to load the other's module.

```ts
const PERCEPTUAL_TYPES = ['jpg', 'jpeg', 'png', 'webp'];
const HASH_BITS = 16;
const PHASH_PREFIX = `phash${HASH_BITS}:`;
const UNHASHABLE = 'none';
const RESIZE = /* Step 1 decision */;
```

### `service/perceptualHashService.ts` (new)

```ts
type PerceptualHashState = 'idle' | 'running' | 'failed';
type PerceptualHashStatus = { state: PerceptualHashState, done: number, total: number };
const IDLE_STATUS: PerceptualHashStatus = { state: 'idle', done: 0, total: 0 };

type PerceptualHashJob = {
    trigger(): void;              // start a pass, or queue one more if a pass is running
    status(): PerceptualHashStatus;
    whenIdle(): Promise<void>;    // resolves when no pass is running or queued (tests, shutdown)
};

const createPerceptualHashJob = (db, { workers = defaultWorkerCount() } = {}): PerceptualHashJob
```

`db` may be the connection's promise, as in `createApp`. It's awaited at the start of each pass.

**`trigger()`**
- If a pass is running, set `pending = true` and return.
- Otherwise start `loop()`: `do { pending = false; await runPass(); } while (pending)`.
- If `runPass` throws: log the error, set state `failed`, and clear `pending`. The next `trigger()` starts again.
- `whenIdle()` returns the current loop promise, or a resolved one.

**`runPass()`**
1. Select the work:

   ```sql
   SELECT Media.id, Local.source
   FROM Media JOIN Local ON Local.id = Media.sourceID
   WHERE Media.isMounted = 1
     AND lower(Local.extension) IN (<PERCEPTUAL_TYPES>)
     AND (Media.perceptualHash IS NULL
          OR (Media.perceptualHash != 'none' AND Media.perceptualHash NOT LIKE '<PHASH_PREFIX>%'))
   ORDER BY Media.id
   ```

   If there are no rows, set state `idle` and return. Otherwise set `{ state: 'running', done: 0, total: rows.length }`.
2. **Pool:** `min(workers, rows.length)` workers, each processing one request at a time.
   - Feed each worker the next row when it replies.
   - On `error` or a non-zero `exit` mid-request: count that row as a read failure (leave it `NULL`), log it, start a replacement worker, and carry on.
3. **Results:** buffer them as `{ id, value }`. A hash gives `PHASH_PREFIX + hex`; a decode error gives `UNHASHABLE`; a read error is logged and gets no value.
   - Every 50 results, and at the end, flush with `withTransaction(db, ...)` running `UPDATE Media SET perceptualHash = ? WHERE id = ?` per result, using one prepared statement as `runForEach` in `repository/local.ts` does.
   - Add that update as `setPerceptualHashes(db, results)` in `repository/media.ts`, next to the other Media queries. Put the select from step 1 there too, as `getMediaNeedingPerceptualHash(db, types, prefix)`.
4. Increment `done` per reply. Log `Perceptual hashed <done>/<total> media` every 100, and at the end.
5. In a `finally`: terminate every worker. When the pass ends, set state `idle`.

**Worker path**

```ts
const isSource = __filename.endsWith('.ts');
const workerFile = path.join(__dirname, `perceptualHashWorker.${isSource ? 'ts' : 'js'}`);
new Worker(workerFile, isSource ? { execArgv: ['--require', 'tsx/cjs'] } : {});
```

- `tsc` compiles `service/perceptualHashWorker.ts` like any other file under `service/`, so no build change is needed. Check that `npm run build` puts it at `build/service/perceptualHashWorker.js`.
- Import `sharp` once in this module before starting workers. `sharp`'s docs ask for that on some platforms, so its native library stays loaded while workers come and go.

## Step 6: Wiring (`bin/www.ts`, `app.ts`, routes)

**`bin/www.ts`**

```ts
const perceptualHashing = createPerceptualHashJob(dbConnection, { workers: workerCountFromEnv() });
const ready = startup(dbConnection, directories);
ready.then(() => perceptualHashing.trigger(), () => {});   // the existing .catch still logs a failure
const app = createApp({ db: dbConnection, directories, ready, perceptualHashing });
```

**`app.ts`**
- `AppOptions` gets an optional `perceptualHashing?: PerceptualHashJob`.
- Store it as `app.locals.perceptualHashing`. Update the doc comment.

**`routes/status.ts`**

```ts
res.json({
    database: req.app.locals.dbStatus,
    perceptualHashing: req.app.locals.perceptualHashing?.status() ?? IDLE_STATUS,
});
```

**`routes/media.ts` (`POST /`):** after `addLocalFile`, if `created`, call `req.app.locals.perceptualHashing?.trigger()`. The trigger goes in the route, not in `mediaService`, so the service doesn't need to know about the job, and it fires only after the transaction has committed.

## Step 7: Remove `image-hash`

- Run `npm uninstall image-hash`.
- Search for leftovers: `image-hash`, `imageHash(` (the function), `PERCEPTUAL_TYPES` and `PHASH_PREFIX` outside `perceptualHashSettings.ts`.
- `compare-decoders.ts` still imports `image-hash`. Add a comment at its top saying it needs `npm install --no-save image-hash` to run again.

## Step 8: Other specs and docs

- **`specs/near-match-duplicates/spec.md`:**
  - "Depends on": hashes are in `Media.perceptualHash`, as `phash16:<hex>` or `none`.
  - Finding candidates: compare `perceptualHash`, use `0 <= distance <= threshold`, and skip `none`/`NULL`.
  - Run after a background pass finishes, not after startup sync. A hook from `runPass` can come later.
  - If Step 1 adopted the resize, note that its distance table was measured without one, and record the resized numbers from Step 1 next to it.
- **`specs/persistence/spec.md`:** in Out of scope, point "Hashing in the background" at this spec.
- **`test/fixtures/README.md`:**
  - `scene-a-small.png` is now its own Media row. It has the same *perceptual* hash as `scene-a.png`, which near-match will use.
  - Add `transparent-corner.png`.

## Step 9: Tests

**Updated**
- `test/unit/startupService.test.ts`:
  - "merges duplicate and resized copies" becomes "merges byte-identical copies": only `scene-a-copy.png` shares `scene-a.png`'s Media row. Update the Media count: one more row than today, plus one for `transparent-corner.png`.
  - Remove the skipped resized-copy test. It belongs to near-match now.
  - "uses a perceptual hash for decodable images" becomes "every Local and Media imageHash is sha256".
- `test/integration/mediaPost.test.ts`: expect `/^sha256:/`, and use the new `computeFileHash` signature.
- `test/integration/status.test.ts`: responses now include `perceptualHashing: { state: 'idle', done: 0, total: 0 }`.
- `test/unit/schema.test.ts`: version 3, and the `perceptualHash` column exists.

**New: `test/unit/perceptualHash.test.ts`**
- **Golden hashes:** call the worker's hashing function directly. Split the pipeline into an exported `hashBuffer(buffer)` in `perceptualHashWorker.ts`, and keep the `parentPort` wiring behind `if (parentPort)`, so it can be imported in tests.
  - Every PNG fixture, including `transparent-corner.png`, equals `GOLDEN_PHASH16` exactly. This uses no resize; if `RESIZE` is on, call `hashBuffer` with an option to turn it off.
  - JPEG and WebP fixtures are within the tolerance from Step 1.
  - `not-an-image.png` throws.
- **Job, against `createTestApp` plus `createPerceptualHashJob(db, { workers: 2 })`:**
  - After `whenIdle()`: decodable fixtures have `phash16:` values, `not-an-image.png`'s Media row has `none`, and the gif and mp4 are `NULL`.
  - A second `trigger()` and `whenIdle()` changes no rows. Compare `SELECT * FROM Media` before and after.
  - Two `trigger()` calls during a pass run exactly two passes. Count them with a test-only `onPassEnd` option, or by spying on the log line.
  - Status is `running` with `done < total` during a pass, and `idle` with `done === total` after.
  - **Requests during a pass:** while a pass runs, `GET /status` answers in under 200 ms. That bound is loose; it's there to catch a decode accidentally running on the main thread.
  - A read failure (a file deleted after the row was selected) leaves `NULL`, and the next pass hashes it again once the file is back.
- **`POST /media`:** a new image's Media row gets a `perceptualHash` after `whenIdle()`.

**New: `test/unit/rekey.test.ts`**

Build a version-2 database by hand:
- Run migrations 1–2 only. Export a `migrateTo(db, version)` helper from `schema.ts` for this.
- Insert Local and Media rows using the fixture paths and the old `phash16:` hashes, from `GOLDEN_PHASH16`.
- Put `scene-a.png`, `scene-a-copy.png` and `scene-a-small.png` under one Media row with `tags = 'kept'`.
- Add a Media row keyed `phash16:...` with no files.

Then run `migrate` and `startup`, and check:
- The scene-a Media row keeps its id and tags, and its `imageHash` is `scene-a.png`'s sha256. `scene-a-copy.png` is still linked to it. `scene-a-small.png` has a new Media row with no tags.
- With the carryover: the original row's `perceptualHash` equals the old `phash16:` key.
- The file-less row is untouched and unmounted.
- A second `startup` doesn't re-key anything. The SELECT in step 1 of Step 4 returns no rows.

## Step 10: Verification

Back up `db/media.sqlite3` first. The upgrade rewrites every hash.

1. **Upgrade:** start against your current database and `directories.json`.
   - The log shows "Migrating database schema to version 3", then the re-key line.
   - `GET /status` reports `database: ready` within seconds.
   - Media ids from `/media` match those from before the upgrade, except for split-off rows. Compare with a saved copy of `/media` from before.
2. **During the pass:** `GET /status` shows `perceptualHashing.running` with `done` increasing, while `/media` answers promptly. Watch Task Manager: CPU across the worker count, and the server's memory stays steady.
3. **Restart:** no hashing at all. There's no re-key line, the pass finds 0 rows, and the status goes straight to `idle`.
4. **Fresh database against `highly-rated`:** startup is ready in seconds. Note how long the full pass takes, and compare it with ~430 ms × 670 for `image-hash`. Record it under Measurements.
5. **`POST /media`** with a new image: it answers right away, and its `perceptualHash` is set shortly after.
6. **Stop mid-pass:** Ctrl+C during a pass, then restart. The next pass picks up only the rows still missing.
7. Restore `directories.json` if you changed it.

## Files touched

| File | Change |
| --- | --- |
| `package.json` | Add `sharp`, remove `image-hash` |
| `service/hashService.ts` | sha256 only; `isCurrentHash` = sha256; export `sha256File` |
| `service/blockHash.ts` | **New**: blockhash copied from `image-hash` (MIT) |
| `service/perceptualHashSettings.ts` | **New**: types, bits, prefix, `none`, resize decision |
| `service/perceptualHashWorker.ts` | **New**: read + `sharp` decode + blockhash; exports `hashBuffer` |
| `service/perceptualHashService.ts` | **New**: the job, the per-pass worker pool, status |
| `service/rekeyService.ts` | **New**: one-time phash → sha256 re-key |
| `service/startupService.ts` | Call `rekeyLegacyHashes` after `migrate` |
| `repository/schema.ts` | Migration 3; `migrateTo` for tests |
| `repository/media.ts` | `getMediaNeedingPerceptualHash`, `setPerceptualHashes` |
| `app.ts` | Optional `perceptualHashing` option, stored on `app.locals` |
| `bin/www.ts` | Create the job; trigger it once startup is ready |
| `routes/status.ts` | Report `perceptualHashing` |
| `routes/media.ts` | Trigger the job when `POST /media` creates a Media row |
| `specs/background-perceptual-hash/tools/compare-decoders.ts` | **New**: decoder comparison and golden-hash output |
| `test/fixtures/images/transparent-corner.png`, `test/fixtures/goldenHashes.ts` | **New** |
| `test/fixtures/README.md` | `scene-a-small.png` note; new fixture |
| `test/unit/perceptualHash.test.ts`, `test/unit/rekey.test.ts` | **New** |
| `test/unit/startupService.test.ts`, `test/unit/schema.test.ts`, `test/integration/mediaPost.test.ts`, `test/integration/status.test.ts` | Updated for sha256 identity, schema v3 and the new status field |
| `specs/near-match-duplicates/spec.md`, `specs/persistence/spec.md` | Point at `perceptualHash` and this spec |

## Measurements

Recorded on 2026-11-14 with `sharp` 0.35.5 and `image-hash` 8.1.1, using `tools/compare-decoders.ts`. A is `image-hash`, B is `sharp` at full size, C is `sharp` resized to 512 px on the long side. Times are single-threaded, per image.

### Hash agreement with `image-hash`

| Folder | Images | d(A,B): exact / max / mean | d(A,C): exact / max / mean |
| --- | --- | --- | --- |
| `test/fixtures/images` | 12 | 8 / 8 / 1.33 | 5 / 8 / 2.42 |
| `duplicates-test` | 39 | 29 / 4 / 0.56 | 23 / 4 / 0.97 |
| `highly-rated` | 646 of 652 | 538 / 25 / 0.46 | 402 / 25 / 1.09 |

- **PNGs match exactly** (lossless decoding), including `transparent-corner.png`. That confirms `blockHash.ts` is a faithful copy and transparent pixels still hash as white.
- **JPEGs differ by a few bits** because libjpeg-turbo and `jpeg-js` produce slightly different pixels.
- **The largest outlier,** `highly-rated/4135.jpg` (25 bits under both B and C), is an ordinary sRGB baseline JPEG. The difference comes from decoding, not resizing: most likely many of its blocks sit right at the median brightness, so small pixel differences flip bits.
- **Only 26 of 648 images** differ by more than 4 bits under C.
- **`image-hash` failed on 6 `highly-rated` images that `sharp` decodes fine:** 5 JPEGs that exceed `jpeg-js`'s memory limit and 1 PNG with trailing data. Before this change those 6 fell back to a sha256 identity hash and never got a perceptual hash.

### Speed (mean ms per image)

| Folder | A | B (of which blockhash) | C (of which blockhash) |
| --- | --- | --- | --- |
| `test/fixtures/images` | 364 | 95 (58) | 33 (4.0) |
| `duplicates-test` | 572 | 169 (103) | 67 (5.5) |
| `highly-rated` | 340 | 92 (58) | 41 (3.8) |

At full size, blockhash alone took up to 541 ms on one image, which would block the event loop if it ran on the main thread. With the resize, the most it took was 20 ms.

### Near-match ground truth (`duplicates-test`, `--pairs`)

| Pipeline | Alternate pairs within 40 | Farthest alternate | Closest unrelated pair |
| --- | --- | --- | --- |
| A | 19 / 19 | 38 (3/22) | 68 |
| B | 19 / 19 | 40 (3/22) | 68 |
| C | 19 / 19 | 40 (3/22) | 68 |

On `highly-rated`, all three pipelines find the same 7 pairs within 40, so the resize adds no false positives.

### Decisions

- **Resize: adopted** (`RESIZE = 512`). The ground truth holds, the same candidates come out of `highly-rated`, and it's 2–3× faster than full size and 8–9× faster than `image-hash`.
- **Carryover: dropped.** The chosen pipeline doesn't match `image-hash` exactly on JPEGs, so migration 3 only adds the column, and every image is hashed once in the background after the upgrade.
- **JPEG tolerance for the golden-hash test: 8** (`amberlyn.jpg`, the largest distance among the fixtures).
- **Workers: kept.** With the resize, blockhash is cheap enough for the main thread, but the pool costs little and keeps the event loop free on any image.
- **For near-match:** 3/22 now sits exactly at the threshold of 40. `specs/near-match-duplicates/spec.md` now suggests a little margin.

### Changes from the plan made during implementation

- **`decodeRGBA` is split out of `hashBuffer`** in `perceptualHashWorker.ts`, so the comparison tool times decoding and blockhash with exactly the app's code.
- **Re-keying is safe to retry.** A file that couldn't be read during the first re-key is retried on a later start, when its Media row already has a sha256 key. The step re-keys a Media row only while its key is still `phash`. After that, the file stays linked if its bytes match the row's key, and is unlinked otherwise. Covered by the last test in `test/unit/rekey.test.ts`.
- **Repeated worker start-up failures fail the pass.** If 3 workers crash in one pass before ever replying (for example, a missing worker file), the pass fails (`state: 'failed'`) instead of marking every row as a read failure.
- **A trigger that arrives while a pass is wrapping up** gets its pass. The job re-checks `pending` once the loop has finished.
- **The default worker count is capped by libuv's threadpool,** not just the CPU count. See "Worker count" below.

### Worker count

Measured on a fresh database against `highly-rated` (652 hashable images), running the compiled build on a machine where `os.availableParallelism()` is 16. While each pass ran, the `GET /media` join query was run every 50 ms on the same connection. "Max unsaved" is how far the database trailed the hashing.

| Workers | Pass | Query p50 / p95 / max (idle p50: 1.6 ms) | Max unsaved |
| --- | --- | --- | --- |
| 15 (the planned default) | 6.8 s | 32 / 84 / 135 ms | 325 |
| 7 | 6.6 s | 11 / 39 / 67 ms | 52 |
| 5 | 6.7 s | 5 / 26 / 44 ms | 50 |
| 3 (the new default) | 9.1 s | 2.2 / 3.0 / 7.7 ms | 49 |

- **Why it plateaus:** libuv's threadpool (4 threads) is shared by the whole process, worker threads included. `sharp`'s decodes and the workers' file reads run on it, and so do the main thread's sqlite3 queries.
- **What happens past that point:** beyond about 5 workers, hashing gets no faster, but database work queues behind decodes. That slows requests and lets results pile up unsaved, which breaks the "lose at most one batch" promise.
- **Why 3:** leaving one pool thread free keeps queries at idle speed, for about 2 s more per pass.

### Upgrade and restart (real database)

- **Upgrade:** started against `db/media.sqlite3` (version 2: 670 files, 646 `phash16:` and 24 `sha256:` Media rows, none with more than one file). Backed up first to `db/media.sqlite3.pre-sha256.bak`.
  - Migration 3 ran, then "Re-keyed 646 media rows to sha256, split off 0 files".
  - No file's Media id changed.
  - The background pass hashed all 652 images, including the 6 `image-hash` couldn't decode. Only the 18 gifs were left `NULL`. No warnings.
  - `/media` answered throughout.
- **Restart:** no re-key, no hashing, and the pass found nothing (`idle`, 0/0).
- **Fresh database:** startup is ready in 1.0 s. With `image-hash`, it took several minutes.
- **Killed mid-pass:** after a kill at 250/652, the next start hashed only the rows still missing.
