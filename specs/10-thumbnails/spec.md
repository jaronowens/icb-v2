# Thumbnails

Right now `previewURL` is a copy of `imageURL`: both point at the original file in a mounted directory. A grid of media loads every image at full size, which can be several MB each.

This spec makes `previewURL` point at a small WebP thumbnail made with [`sharp`](https://www.npmjs.com/package/sharp), which the app already uses for perceptual hashing (`specs/07-background-perceptual-hash`).

Thumbnails are stored on disk under the file's sha256, because identity is a hash of the file's bytes. That means:
- **A thumbnail can never go stale.** If a file's bytes change, it gets a new hash and so a new thumbnail path.
- **The browser can cache thumbnails forever** (`immutable`), and the server never has to compare modification times.
- **Duplicate files share one thumbnail**, because they share a hash.

## Goals
- `previewURL` in `/media` responses points at a thumbnail for every image `sharp` can decode, and at the original file for everything else.
- Every `previewURL` works on the first request, whether or not its thumbnail has been made yet.
- Thumbnails are served as static files, with long-lived caching. They're only generated when one is missing.
- A background job makes thumbnails ahead of time, so most requests are cache hits.

## Spec

### Where thumbnails are stored
- **Folder:** `db/thumbnails/` by default, next to `db/media.sqlite3`. `db/` is already gitignored. The `THUMBNAIL_DIR` env var overrides it. `createApp` takes it as an option (`thumbnailDir`), so tests can use a temp folder.
- **Never inside a mounted directory.** The app doesn't write into the user's media folders.
- **File path:** `<thumbnailDir>/<aa>/<hex>-<size>.webp`.
  - `<hex>` is the 64-character sha256 from `imageHash`, without the `sha256:` prefix.
  - `<aa>` is the first two characters of `<hex>`. Splitting into 256 subfolders keeps any one folder from holding tens of thousands of files.
  - `<size>` is the thumbnail's target *shortest* side in pixels (see "Sizing"). It's part of the name so other sizes can be added later without changing the scheme.
- **Sizes:** one size for now, `THUMBNAIL_SIZE = 900`. Only sizes in `THUMBNAIL_SIZES` (just `[900]` for now) are ever generated, so a request can't make the server create files of any size it likes.

### Sizing
The front end shows thumbnails in a square grid with `object-fit: cover`, so the *shortest* side is the one that has to fill a tile. Thumbnails are sized by their shortest side, not their longest.
- **Short side: 900 px.** The current grid uses 450 CSS px tiles. A 1× screen needs 450 px, Windows laptops at 125–150% scaling need 563–675 px, and 2× screens need 900 px. 900 covers all of them, and still works if the tiles get smaller.
  - Sizing by the longest side doesn't work with `cover`. With a 512 px longest side, for example, a 2:3 portrait would be 341×512, and its short side would be stretched to fill a 450 px tile even on a 1× screen.
- **Long side capped at 3× the short side (2700 px).** Without a cap, a very tall strip such as 1000×20000 would come out at 900×18000, which saves almost nothing. With the cap, it comes out at 135×2700. That's fine for a grid tile, which only shows the cropped middle anyway.
- **No upscaling:** an image already smaller than the target keeps its own size.
- **No cropping:** the whole image is kept, at its own aspect ratio. Square crops would make the smallest files for today's grid, but they'd tie every thumbnail to the current layout. A full-aspect thumbnail also works for a masonry or list layout later.
- **Approximate cost:** a 900×1350 WebP at quality 80 is about 100–250 KB, against several MB for the originals. The main gains are in the browser: much less decoding and memory, and grids that scroll smoothly.

  The scale and the final dimensions are:

  ```ts
  const short = Math.min(width, height), long = Math.max(width, height);
  const scale = Math.min(size / short, (3 * size) / long, 1);
  const target = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  ```

  `width` and `height` here are measured *after* EXIF orientation (see "Generating a thumbnail").

### Which files get thumbnails
- `THUMBNAIL_TYPES = ['jpg', 'jpeg', 'png', 'webp']`, the same types as `PERCEPTUAL_TYPES`. They're kept as a separate constant so the two lists can change on their own later.
- gif, mp4 and webm don't get thumbnails (see "Out of scope"). Their `previewURL` is their `imageURL`.

### `previewURL` in responses
- It's computed when the response is built, from the file's `imageHash` and extension:

  ```ts
  const previewURL = (imageURL, imageHash, extension) =>
      THUMBNAIL_TYPES.includes(extension)
          ? `${BASE_URL}/thumbnails/${hex.slice(0, 2)}/${hex}-${THUMBNAIL_SIZE}.webp`
          : imageURL;
  ```

  Put this in a new `service/thumbnailService.ts`, and call it from `toMediaNode` and from wherever `MediaFile` entries are built for `GET /media/:id`.
- It doesn't depend on whether the thumbnail exists yet. The URL stays the same, and the fallback handler makes the thumbnail on the first request if needed.
- Unmounted media keep `previewURL: null`, as they do today.
- `MediaFile` entries in `GET /media/:id` use each Local file's own `imageHash`. With sha256 identity, that's the same as the Media row's hash, but using the file's own hash stays correct if that ever changes. `getLocalNodesForMedia` has to add `imageHash` to its `SELECT`.
- It uses the same `BASE_URL` as `imageURL`, so both URLs have the same form.

### Dropping `Local.previewURL`
The stored column would just be a copy of `imageURL`, so it's removed:
- **Schema migration 5:** `ALTER TABLE Local DROP COLUMN previewURL`. The bundled SQLite supports `DROP COLUMN`, which needs 3.35+. Confirm that while implementing.
- `localFileNode` loses `previewURL`. `initializeLocalNode`, `insertLocalNodes` and the two `UPDATE` statements in `repository/local.ts` stop writing it.
- `repository/media.ts` stops selecting `Local.previewURL`.
- `test/unit/rekey.test.ts` builds a schema-version-2 database by hand. It keeps its own `previewURL` column, because version 2 had one.

### Serving thumbnails
In `app.ts`, mount these before the directory mounts:

```ts
app.use('/thumbnails', express.static(thumbnailDir, { maxAge: '1y', immutable: true, index: false }));
app.use('/thumbnails', thumbnailFallback); // only reached when express.static didn't find the file
```

- **Cache hit:** `express.static` serves the file with `Content-Type: image/webp`, an ETag, range support and `Cache-Control: public, max-age=31536000, immutable`.
- **Cache miss:** `express.static` passes the request on to `thumbnailFallback` (in `routes/thumbnails.ts`). For `GET` and `HEAD` requests, it:
  1. Matches the path against `^/([0-9a-f]{2})/([0-9a-f]{64})-(\d+)\.webp$`. The two-character folder has to be the first two characters of the hash, and the size has to be in `THUMBNAIL_SIZES`. Anything else is a `404`. This regex is also the only path check needed: nothing outside the folder can be reached, because only that exact shape is accepted.
  2. Looks up the mounted Media row with `imageHash = 'sha256:<hex>'`, and the `source` and `extension` of its representative Local file. Unknown, unmounted, or not a `THUMBNAIL_TYPES` file: `404`.
  3. Generates the thumbnail (see "Generating a thumbnail"), then `res.sendFile`s it with the same caching headers as the static mount.
  4. If the source can't be decoded, it redirects (`302`) to the file's `imageURL` with `Cache-Control: no-cache`. An `<img>` pointing at a broken thumbnail then shows the original, or the browser's usual broken-image icon if the original doesn't load either. Nothing is written to the cache.
  5. If the source can't be read (missing file, disconnected drive), it answers `404`. Nothing is written, so a later request tries again.
- **No database wait:** `/thumbnails` isn't behind `requireDatabase`. A cache hit never touches the database, and the fallback answers `503` itself while `dbStatus` isn't `ready`.
- **Reserved name:** a mounted directory named `thumbnails` would clash with this route. `isValidDirectoryName` rejects that name, and the existing invalid-name handling keeps its rows.

### Generating a thumbnail
One function, `ensureThumbnail(hex, size, source)` in `service/thumbnailService.ts`. Both the fallback handler and the background job use it.

- **Pipeline:**

  ```ts
  const buffer = await readFile(source);              // read once: used for the metadata and the pipeline
  const { width, height } = orientedSize(await sharp(buffer).metadata());
  const target = thumbnailDimensions(width, height, size); // see "Sizing"
  await sharp(buffer)
      .rotate()                                       // apply EXIF orientation, unlike perceptual hashing
      .resize({ width: target.width, height: target.height, fit: 'fill' })
      .webp({ quality: 80 })
      .toFile(tempPath);
  ```

  - **Why read the metadata first:** `sharp` allows only one `resize` per pipeline, and no single `fit` mode does "short side to 900, long side at most 2700". So the target size is worked out from the header first. `metadata()` only reads the header, so it's cheap.
  - **`orientedSize`:** gives the width and height after EXIF orientation. Use `metadata().autoOrient` if the installed `sharp` provides it (0.34+). Otherwise swap width and height for `orientation` 5–8. If the orientation is ignored here, a rotated phone photo gets a target with its sides swapped, and `fit: 'fill'` stretches it.
  - **`fit: 'fill'`** is safe because the target already keeps the aspect ratio, to within rounding. It makes the output exactly the computed size.
  - **`.rotate()`** with no arguments applies the EXIF orientation, so phone photos show the right way up. Perceptual hashing leaves it out on purpose. Thumbnails are for people to look at, so they need it.
  - Images already smaller than the target are kept at their own size (`scale` is capped at 1), but they're still converted to WebP. Every thumbnail has the same format and path rule, with no special cases.
  - For an animated WebP, `sharp` reads only the first frame, which is what a thumbnail wants.
- **Atomic writes:** write to `<final>.<random>.tmp` in the same folder (create the folder if needed), then `rename` it to the final path. A half-written file is never served.
  - On Windows, `rename` can fail with `EPERM` or `EEXIST` if another writer finished first, or if the file is open. If the final file exists after that, treat it as success and delete the temp file.
  - Clean up the temp file whenever an error happens.
- **One job per thumbnail at a time:** a `Map<string, Promise<void>>` keyed by `<hex>-<size>`. Requests for a thumbnail that's already being made wait on the same promise. A grid with duplicates, or the background job and a request asking for the same image at once, make it only once. The entry is removed when the promise settles.
- **Limiting how many run at once:** at most `THUMBNAIL_CONCURRENCY` (default 2, overridable with an env var of the same name) thumbnails are made at a time. Anything else waits in a FIFO queue. `sharp` works on libuv's threadpool, not the event loop, so this doesn't block requests. But that pool is shared with database queries, file reads, and the perceptual hash workers' I/O, and a cold grid of 200 images would otherwise fill it.
- **Errors:** decode failures and read failures are reported separately, the same way as in `perceptualHashWorker.handleRequest`, so callers can tell them apart. Neither one is cached.
- **Where it runs:** on the main thread, through `sharp`'s async API. Each thumbnail is a single libvips pipeline, so a worker pool isn't needed the way it is for blockhash, which runs in JS.

### Background job (warming the cache)
- **When it runs:** after the perceptual hash job goes idle, both after its first pass at startup and after the pass that `POST /media` triggers. Running the two jobs one after the other keeps them from competing for CPU and libuv's threadpool on a fresh database. Until the thumbnail job gets to a row, requests generate its thumbnail on demand. It also runs if the perceptual hash job fails. Only one pass runs at a time, and a trigger during a pass runs one more pass afterwards, as the perceptual hash job does. Started from `bin/www.ts`, next to the perceptual hash job, so tests can start and await it themselves.
- **What it does:** for every mounted Media row whose representative file is a `THUMBNAIL_TYPES` file and whose `perceptualHash` isn't `'none'`, it checks whether `<hex>-<THUMBNAIL_SIZE>.webp` exists (one `stat`) and calls `ensureThumbnail` if it doesn't.
  - A full pass over an already-warm cache is one query plus one `stat` per row.
  - It doesn't add a database column to track thumbnails. The file existing *is* the record, so deleting the cache folder by hand is a safe way to rebuild it.
- **Sharing the limit:** it goes through the same concurrency limit and in-flight map as requests. Its jobs are queued with lower priority, so a thumbnail someone is waiting on jumps ahead of background work. The queue has two levels: request jobs always run first.
- **Errors:** decode and read failures are logged and skipped.
  - Images that the perceptual hash job already marked undecodable (`perceptualHash = 'none'`) aren't attempted at all. That reuses stored data, so no thumbnail column is needed.
  - An image that's readable but can't be decoded, and isn't marked yet (its perceptual hash is still `NULL`), is tried again on the next pass.
  - The on-demand fallback still tries every image, and redirects to the original if it fails.
  - A failure of the job as a whole is logged and doesn't affect the server.
- **Progress:** logged every 100 thumbnails.

### Status
`GET /status` adds the job's state, in the same shape as `perceptualHashing`:

```json
{
  "database": "ready",
  "perceptualHashing": { "state": "idle", "done": 670, "total": 670 },
  "thumbnails": { "state": "running", "done": 120, "total": 670 }
}
```

`total` counts the rows that needed a thumbnail on this pass, not every row.

### Code that changes
- `service/thumbnailService.ts` (new): the settings (`THUMBNAIL_TYPES`, `THUMBNAIL_SIZE`, `THUMBNAIL_SIZES`, `THUMBNAIL_CONCURRENCY`), `previewURL`, `thumbnailPath`, `thumbnailDimensions`, `orientedSize`, `ensureThumbnail` with its queue and in-flight map, and the background job.
- `routes/thumbnails.ts` (new): `thumbnailFallback`.
- `app.ts`: the `thumbnailDir` option, the static mount, and the fallback.
- `bin/www.ts`: resolve `THUMBNAIL_DIR`, and start the job after `ready`.
- `service/mediaService.ts`: compute `previewURL` in `toMediaNode` and for `MediaFile` entries. `POST /media` already triggers the perceptual hash job, and the thumbnail job follows it.
- `service/perceptualHashService.ts`: an `onIdle` callback, called when the job's loop ends with no pass pending, whether it succeeded or failed.
- `service/startupService.ts`: reserve the `thumbnails` directory name.
- `routes/status.ts`: report the job's state.
- `repository/schema.ts`: migration 5.
- `repository/local.ts`, `repository/media.ts`, `entity/localFileNode.ts`, `service/localFileService.ts`: stop storing `previewURL`. Add `imageHash` to `getLocalNodesForMedia`.
- `entity/mediaNode.ts`: no shape change. Update the `previewURL` comments.

## Tests
- **`previewURL`:**
  - For each jpg/jpeg/png/webp fixture in `GET /media` and `GET /media/:id`, `previewURL` has the thumbnail form. For gif/mp4/webm it equals `imageURL`. Unmounted media keep `null`.
  - Every `previewURL` returned by `GET /media` answers `200` with `Content-Type: image/webp` (or the original type for gif/mp4/webm). This follows the existing "returns an imageURL the app serves" test.
- **Fallback:**
  - On an empty cache folder, a request makes the file. It's WebP, and the aspect ratio is kept to within one pixel.
- **Sizing** (unit tests on `thumbnailDimensions`, plus `ensureThumbnail` on images generated with `sharp` in a temp folder):
  - A 3000×2000 image gives 1350×900, and a 2000×3000 image gives 900×1350.
  - A 1000×20000 strip gives 135×2700, because the long-side cap applies.
  - A 600×400 image stays 600×400, with no upscaling.
  - A 1×5000 image gives at least 1 px on each side.
  - A second request is served by `express.static` (the file's mtime doesn't change), with `Cache-Control` containing `immutable`.
  - Two requests at once for the same thumbnail run `sharp` once. Spy on `ensureThumbnail`'s internals, or count files written.
  - `404` for: a malformed path, a folder that doesn't match the hash, a size not in `THUMBNAIL_SIZES`, an unknown hash, an unmounted hash, and a gif/mp4 hash.
  - `not-an-image.png` gives a `302` to its `imageURL`, and nothing is written to the cache.
  - A file deleted after sync gives `404`, and nothing is written.
  - `503` before the database is ready, for a hash that isn't cached yet.
  - No `.tmp` files are left in the cache folder after any of the above.
- **Orientation:** add a small JPEG fixture with EXIF orientation 6 (rotated 90°), and list it in `test/fixtures/README.md`. Its thumbnail's width and height are swapped compared with the raw pixel data.
- **Background job:**
  - After one pass, every decodable fixture has a thumbnail and `not-an-image.png` doesn't.
  - A second pass generates nothing.
  - A trigger during a pass runs exactly one more pass.
  - `/status` reports progress.
- **Migration 5:** a schema-version-4 database keeps every row, and `Local` no longer has a `previewURL` column.
- **Directory name:** a directory named `thumbnails` is rejected like any other invalid name.
- Tests use a temp `thumbnailDir` for each suite and delete it afterwards.

## Out of scope
- **Thumbnails for gif and video.** A gif's first frame is easy with `sharp`, but an animated preview is a different feature. Video needs `ffmpeg`. Both keep `previewURL = imageURL`.
- **More than one size, or choosing a size per request.** The path scheme and `THUMBNAIL_SIZES` leave room for it.
- **Deleting thumbnails.** Media deletion isn't built yet. When it is, it should delete that hash's thumbnails too, or there should be an occasional sweep that removes thumbnails whose hash is no longer in `Media`. Until then, orphaned thumbnails just sit on disk.
- **AVIF, or choosing the format from the request's `Accept` header.**

## Acceptance
- On a fresh database and an empty cache against `highly-rated` (670 images), `GET /media` returns thumbnail `previewURL`s straight away. Each one loads in a browser, either generated on request or already made by the background job.
- When the background pass finishes, `db/thumbnails/` holds one WebP per decodable Media row. A restart generates nothing.
- A thumbnail grid loads much less data than the originals. Record the total size of the originals and of the thumbnails for `highly-rated` in `implementation.md`.
- While the background pass is running, `/media` and cache-hit thumbnail requests keep answering promptly.
- `POST /media` with a new image returns right away. Its `previewURL` works on the first request, and the background job makes its thumbnail shortly after.

## Open questions
- **Thumbnail size (decided):** 900 px short side, long side capped at 3×, as in "Sizing". If the new front end's tiles change a lot, change `THUMBNAIL_SIZE`: the old files become orphans and the background job makes the new ones. If different screens ever need different sizes, add another size to `THUMBNAIL_SIZES` and use `srcset`.
- **WebP quality (decided):** 80. Samples of line art from `highly-rated` at 80, 85 and 80 with `smartSubsample` were compared, and 80 was kept. 80 is a common default. Check it on a few images with fine line art from `highly-rated`. If that shows artifacts, try `quality: 85` or `smartSubsample: true`.
