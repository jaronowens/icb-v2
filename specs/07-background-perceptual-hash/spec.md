Right now a file's identity hash is a perceptual hash (`phash16:<hex>`) for jpg/jpeg/png/webp, and sha256 for everything else. The perceptual hash is by far the slowest part of startup. Measured on the 12 images in `test/fixtures` (10 MB):

| | Total | Per file |
| --- | --- | --- |
| sha256 | 17 ms | ~1.4 ms |
| phash16 (`image-hash`) | 5,131 ms | ~430 ms |

`image-hash` decodes every image in pure JS (`jpeg-js`, `pngjs`, a WASM webp decoder), so it's about 300× slower than reading the bytes. The work is CPU-bound on the main thread, so the `concurrency = 8` in `hashLocalNodes` doesn't actually run decodes in parallel.

Perceptual hashes are also the wrong tool for identity. Exact-match merging catches only about two-thirds of resized copies, and no threshold separates resized copies from alternate versions (see `specs/near-match-duplicates/spec.md`). Hydrus, which the app will integrate with later, identifies every file by sha256. Its duplicate finder keeps perceptual hashes separately and only uses them to search for similar files.

This spec covers both halves of that split:
1. **sha256 becomes the only identity hash.** It's fast enough to stay in startup.
2. **Perceptual hashes move to their own column**, computed by a background job after the server is ready. They feed near-match detection and never decide which Media row a file belongs to.
3. **Images are decoded with [`sharp`](https://www.npmjs.com/package/sharp) instead of `image-hash`.** The hash algorithm stays the same (blockhash, 16 bits), so the near-match measurements still apply. `sharp` will also be the tool for thumbnails later.

This replaces the "hashing in the background" item listed as out of scope in `specs/02-persistence/spec.md`.

## Goals
- Startup computes only sha256 hashes, so it's limited by disk speed, not image decoding.
- Every image's perceptual hash is still computed, but in the background, without blocking requests.
- Existing Media rows keep their ids through the migration wherever that's possible.

## Spec

### Identity hash
- `Local.imageHash` and `Media.imageHash` are always `sha256:<hex>`, for every file type.
- `computeFileHash` no longer calls `image-hash`. `isCurrentHash` returns true only for `sha256:` hashes, so any leftover `phash` hash is treated as out of date.
- Two files share a Media row only when their bytes are identical. Resized and re-compressed copies become separate Media rows, and near-match detection finds them (see "Effect on near-match duplicates").

### Perceptual hash storage
- New column: `Media.perceptualHash TEXT`, nullable.
  - `NULL`: not computed yet, or the file type isn't perceptually hashable (gif, mp4, webm).
  - `phash16:<hex>`: computed with the current settings. The prefix keeps the bit count, as it does today.
  - `none`: the image couldn't be decoded. It isn't retried, because a changed file gets a new sha256 and so a new Media row anyway.
- It lives on Media, not Local. With sha256 identity, every file linked to one Media row has the same bytes and so the same perceptual hash, and near-match compares Media rows. Each distinct image is decoded only once.
- The hash settings (`HASH_BITS`, the prefix, the list of decodable types) move out of the identity path into the background job's module.

### Decoding with `sharp`
- **Why the algorithm stays:** `image-hash` does two things: it decodes the image in pure JS (the slow part), then runs blockhash over the RGBA pixels. Only the decoding is replaced. Keeping blockhash keeps the 256-bit hashes and the threshold of 40 from `specs/near-match-duplicates/spec.md`. A different algorithm, such as the 64-bit DCT pHash in `sharp-phash`, would mean redoing that tuning from scratch.
- **The pipeline:**

  ```ts
  const { data, info } = await sharp(buffer)
      .toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
  const hex = blockhash({ width: info.width, height: info.height, data }, HASH_BITS, 2);
  ```

  Blockhash reads exactly 4 bytes (RGBA) per pixel and treats fully transparent pixels as white, so:
  - `toColourspace('srgb')` turns greyscale and CMYK images into RGB. Without it, a greyscale image comes out with 1 or 2 channels.
  - `ensureAlpha()` adds the alpha channel.
  - `depth: 'uchar'` keeps 16-bit PNGs at 8 bits per channel.
  - No `.rotate()`: `image-hash` ignores EXIF orientation, so hashes match only if `sharp` ignores it too.
- **Where blockhash comes from:** `image-hash` doesn't export its blockhash function (its `exports` only expose `imageHash()`). Copy `node_modules/image-hash/lib/block-hash.js` into `service/blockHash.ts`, converted to TypeScript, and keep its MIT copyright notice in a header comment. Then remove `image-hash` from `package.json`.
- **Resizing before hashing (decided by measurement):** `sharp` can shrink a JPEG while decoding it, which makes large images much cheaper to hash. Blockhash averages the image into a 16×16 grid anyway, so a resize to around 512 px on the long side should barely change the result. Use it only if the measurement below shows that.
- **Measure first:** before wiring `sharp` into the job, write `specs/07-background-perceptual-hash/tools/compare-decoders.ts` (run with `npx tsx`, since it imports `service/blockHash.ts`), modelled on `specs/near-match-duplicates/tools/pairwise-distances.js`. Run it over `test/fixtures/images`, `duplicates-test` and `highly-rated`. For each image it reports the Hamming distance between:
  - `image-hash`'s hash and the `sharp` hash with no resize
  - `image-hash`'s hash and the `sharp` hash with the resize

  Record the results in `specs/07-background-perceptual-hash/implementation.md`, then decide:
  - **Resize:** use it if the near-match ground truth in `duplicates-test` still holds with it. That means all 19 alternate pairs are within 40, and the closest unrelated pair stays well above 40.
  - **Carryover:** keep the migration's carryover only if the chosen pipeline matches `image-hash` exactly (distance 0) on every test image. Otherwise drop the carryover so every image is recomputed once in the background, and old and new hashes are never compared with each other.
- **Workers:** each worker loads `sharp` once. libvips has its own thread pool, so set `sharp.concurrency(1)` in each worker to avoid running the pool size × libvips threads at once. Also set `sharp.cache(false)`: each file is read once, so caching only uses memory.
- **Decode failures:** `sharp` errors (corrupt data, or a file that isn't really an image, like `not-an-image.png`) count as decode failures and store `none`, as before.

### Background job
- **When it runs:**
  - Once `startup()` resolves.
  - Whenever `POST /media` creates a new Media row.
  - Only one pass runs at a time. A trigger during a pass sets a flag, and the job runs another pass when it finishes. That pass only picks up the new rows.
- **What it hashes:** mounted Media rows whose representative file (`sourceID`) has a perceptually hashable extension, and whose `perceptualHash` is `NULL` or uses an outdated prefix. Rows stored as `none` are skipped.
- **Where it runs:** in a `worker_threads` pool, not on the main thread. Each decode blocks for hundreds of milliseconds, which would stall every request during a long pass. The pool size defaults to one less than libuv's threadpool size (`UV_THREADPOOL_SIZE`, 4 by default, so 3 workers), capped at the CPU count minus one. Workers share that threadpool with the main thread's database queries and file reads, so using all of it for hashing slows every request (see "Worker count" in `implementation.md`). The `PERCEPTUAL_HASH_WORKERS` env var overrides it.
- **Writing results:** results are written in small batches, about 50 rows per transaction. Stopping the server mid-pass loses at most one batch, and the next pass carries on where it stopped.
- **Errors:**
  - A file that fails to decode gets `none`.
  - A file that can't be read (missing, or its drive was disconnected) is left `NULL` and retried on the next pass.
  - A crashed worker is replaced, and its file counts as a read failure.
  - A failure of the job as a whole is logged and doesn't affect the server.
- **Progress:** logged every 100 files, as `hashLocalNodes` does today.

### Status
`GET /status` adds the job's state:

```json
{
  "database": "ready",
  "perceptualHashing": { "state": "running", "done": 120, "total": 670 }
}
```

`state` is `idle`, `running` or `failed`. `/media` doesn't wait for the job. It works normally whether perceptual hashes are done or not.

### Migration
**Schema migration 3 (SQL only):**
- `ALTER TABLE Media ADD COLUMN perceptualHash TEXT`.
- `UPDATE Media SET perceptualHash = imageHash WHERE imageHash LIKE 'phash16:%'`. Hashes already computed with the current settings carry over for free. Older `phash8:` values are left `NULL` and recomputed.
  - This step is kept only if the `sharp` measurement shows identical hashes (see "Measure first"). If it's dropped, every image is recomputed once in the background after the upgrade.

**One-time re-key step (in `startup()`, after `migrate`, before the directory sync):** migrations run inside a SQL transaction and can't hash files, so this runs as a startup step. It only does anything while some `Local.imageHash` still starts with `phash`, so later starts skip it with a single query.
1. sha256 every Local row whose `imageHash` starts with `phash` and whose file still exists. Skip missing files: the directory sync deletes their rows right after. At ~1 ms per file this is fast enough to run before the server is ready.
2. In one transaction, for each Media row those Local rows point to:
   - Take the sha256 of its lowest-id Local file. If no other Media row already uses that sha256, set it as this row's `imageHash`. The row keeps its `id`, `tags` and `perceptualHash`.
   - Local rows with that same sha256 stay linked to this row.
   - Local rows with a different sha256 (resized copies that used to merge) get their new hash and `mediaID = -1`. The normal `populateMediaFromSource` / `syncUnlinkedLocalNodes` steps then give them their own Media rows.
   - If another Media row already has that sha256 (only possible if files changed between starts), unlink all of this row's files instead. It ends up unmounted, like any Media row with no files.
3. Every other Local row gets its new sha256 hash in the same transaction.

**Results of the migration:**
- **Media with no files left:** a Media row still keyed `phash` with no Local files is never matched again. It stays unmounted with its tags kept, like any other Media row whose files are gone.
- **Tags on split-off rows:** a Media row created for a split-off copy starts with no tags. Nothing in the API writes tags yet, so no real data is lost.

### Code that changes
- `service/hashService.ts`: identity hashing becomes sha256 only.
- `service/perceptualHashService.ts` (new): the job, its worker pool, and the status it reports.
- `service/perceptualHashWorker.ts` (new): the worker. It decodes with `sharp` and hashes with `blockHash`.
- `service/blockHash.ts` (new): blockhash, copied from `image-hash` (see "Decoding with `sharp`").
- `package.json`: add `sharp`, remove `image-hash`.
- `repository/schema.ts`: migration 3.
- `service/startupService.ts`: the re-key step. Starting the job stays in `bin/www.ts`, next to `startup()`, so tests can start it themselves and await it.
- `service/mediaService.ts`: `POST /media` triggers the job after it creates a Media row.
- `routes/status.ts`: report the job's state.

## Effect on near-match duplicates
Update `specs/near-match-duplicates/spec.md` as part of this work:
- It compares `Media.perceptualHash` instead of `Media.imageHash`.
- Candidates include distance 0 (`0 <= distance <= threshold`). Identical perceptual hashes no longer merge automatically, so they need a review decision like any other pair.
- It runs after the background job finishes a pass, not after startup sync.

## Tests
- `test/unit/startupService.test.ts`:
  - `scene-a-small.png` no longer merges with `scene-a.png`. Only the byte-for-byte copy does. Media counts change to match.
  - "uses a perceptual hash for decodable images" becomes "every file's imageHash is sha256".
  - The skipped "merges a real resized copy" test moves to the near-match spec.
- `test/integration/mediaPost.test.ts`: expect `sha256:` instead of `phash16:`.
- `test/fixtures/README.md`: update the `scene-a-small.png` description.
- New tests:
  - The job fills `perceptualHash` for decodable images, writes `none` for `not-an-image.png`, and leaves gif/mp4 `NULL`.
  - A second pass hashes nothing.
  - A trigger during a pass runs exactly one more pass.
  - `/status` reports progress.
  - A request made during a pass is answered without waiting for the pass.
  - Golden hashes: before `image-hash` is removed, record its hash for every decodable fixture as constants in the test.
    - PNG decoding is lossless, so the `sharp` pipeline (without resize) must match the PNG golden hashes exactly. That proves `blockHash` was copied correctly.
    - JPEG and WebP hashes must be within the largest distance the measurement found.
  - A transparent PNG matches its golden hash, which confirms that `ensureAlpha()` and the transparent-is-white rule carried over. None of the current fixtures have transparent pixels, so add a small one and list it in `test/fixtures/README.md`.
  - Re-key: build a schema-version-2 database with `phash16:` rows, including two files merged under one phash, then start. The merged row keeps its id for its lowest-id file's bytes, the other file gets a new Media row, and `perceptualHash` carries over.

## Out of scope
- Near-match candidate detection and review: `specs/near-match-duplicates/`.
- Thumbnails. `sharp` and the worker pool make them straightforward later, but they're a separate spec.
- Perceptually hashing gifs or other formats `sharp` can decode (e.g. a gif's first frame, avif, tiff). The decodable types stay jpg/jpeg/png/webp for now.
- Replacing `image-size` in `dimensionService` with `sharp().metadata()`.
- Exposing `perceptualHash` in the `/media` response.
- Watching directories for changes while the server runs.

## Acceptance
- Start against the `highly-rated` folder (670 images) on a fresh database. `GET /status` reports `database: ready` within seconds, not minutes, and `/media` returns all images while `perceptualHashing` is still `running`.
- `implementation.md` records the decoder comparison and the resize and carryover decisions based on it.
- With `sharp`, a full background pass over `highly-rated` takes much less time than the ~430 ms per image that `image-hash` needs.
- During the pass, `/media` keeps answering promptly. The pass finishes with every jpg/jpeg/png/webp Media row hashed or marked `none`.
- Restart: no sha256 or perceptual hashing happens.
- Upgrading a database created before this change keeps Media ids for every image whose files were byte-identical. Resized copies that had merged now have their own Media rows.
- `POST /media` with a new image returns right away, and its `perceptualHash` is filled in shortly after.
