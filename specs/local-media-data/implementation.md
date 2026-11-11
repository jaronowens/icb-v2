# Implementation Plan: Local Media Dimensions

Implements `specs/local-media-data/spec.md`.

## Decisions

| Topic | Decision |
| --- | --- |
| Where dimensions are stored | **`Local` only.** Migration 2 adds `width INTEGER` and `height INTEGER` to `Local`. `Media` gets no new columns. |
| How `GET /media` gets them | `getMedia` already joins `Local` on `Media.sourceID`, so it selects `Local.width` and `Local.height` from the representative file. **`populateMediaFromSource` is not changed.** That's a deviation from the spec's Problems list: `Media` has nothing to store them in, and copying them there would mean keeping a second copy in sync whenever `refreshMediaSources` re-points a source. |
| Library entry point | `imageSize(buffer)` from the main `image-size` export. `image-size/fromFile` doesn't compile under the current `tsconfig.json` (`moduleResolution` defaults to `node10`, which ignores package `exports`; tried it and got TS2307). The new service reads the first 512 KB of the file itself, which is exactly what `imageSizeFromFile` does internally. The tsconfig stays as it is. |
| Which types get measured | `jpg`, `jpeg`, `png`, `webp`, `gif`, i.e. the image types in `supportedFileTypes`. `mp4` and `webm` are never measured and stay `NULL`. |
| Failures | Any read or parse error logs a warning and leaves `width`/`height` as `NULL`. It never stops the file from being inserted or hashed. |
| EXIF orientation | Store the **displayed** dimensions: when `image-size` reports orientation 5–8 (rotated 90°/270°), width and height are swapped. Browsers apply EXIF orientation by default, so the stored aspect ratio matches what the front end shows. |
| Backfilling existing rows | **During sync, not in the migration.** In `syncDirectory`, any *unchanged* row that has a measurable extension and `width IS NULL` is measured and updated. Existing rows get filled in on the first start after migrating, and so do rows on drives that were offline then. |
| Cost of retrying | An image that can't be measured stays `NULL` and is tried again on every start. That's accepted: measuring reads at most 512 KB and only decodes the header, and failures should be rare. Videos are never retried because their extension isn't measurable. |
| `NULL` in the API | `MediaNode.width`/`height` become `number \| null`, and `GET /media` returns JSON `null` for unmeasured or unmeasurable media (replacing the hard-coded `0`). |

---

## Step 1: Schema migration (`repository/schema.ts`)

Bump the version and add migration 2. Migration 1 stays exactly as it is.

```ts
const CURRENT_VERSION: number = 2;

const migrations = {
    1: /* unchanged */,
    // 1 -> 2: image dimensions. Existing rows get NULL and are measured on the next sync.
    2: async (db) => {
        await db.run('ALTER TABLE Local ADD COLUMN width INTEGER');
        await db.run('ALTER TABLE Local ADD COLUMN height INTEGER');
    },
};
```

On a fresh database, migrations 1 and 2 run back to back, so the columns exist before the first sync. `migrate()` already wraps each migration in a transaction. Once a database reaches version 2, older commits will refuse to start against it (the existing "newer than this code supports" check). That's expected.

## Step 2: Entities

`entity/localFileNode.ts` and `entity/mediaNode.ts`:

```ts
width: number | null,
height: number | null,
```

(`strict` is off, so this is for documentation, but it states the contract.)

## Step 3: New service, `service/dimensionService.ts`

It sits next to `hashService.ts` and follows the same shape.

```ts
import { open } from 'node:fs/promises';
import { imageSize } from 'image-size';
import { localFileNode } from '../entity/localFileNode';

/* File types image-size can read. Everything else (videos) is stored with NULL dimensions. */
const MEASURABLE_TYPES: string[] = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
/* Same limit image-size's own imageSizeFromFile uses: headers are near the start of the file. */
const MAX_HEADER_BYTES: number = 512 * 1024;
/* EXIF orientations 5-8 rotate the image 90 or 270 degrees, so the displayed width and height are swapped. */
const ROTATED_ORIENTATIONS: number[] = [5, 6, 7, 8];

const isMeasurable = (extension: string): boolean => MEASURABLE_TYPES.includes(extension.toLowerCase());

/* Reads the header of the file and returns its displayed dimensions, or null if it can't be measured. */
const readDimensions = async (filePath: string, extension: string): Promise<{ width: number, height: number } | null> => {
    if (!isMeasurable(extension)) {
        return null;
    }
    let handle;
    try {
        handle = await open(filePath, 'r');
        const { size } = await handle.stat();
        const length = Math.min(size, MAX_HEADER_BYTES);
        const buffer = new Uint8Array(length);
        await handle.read(buffer, 0, length, 0);
        const { width, height, orientation } = imageSize(buffer);
        if (!width || !height) {
            return null;
        }
        return ROTATED_ORIENTATIONS.includes(orientation)
            ? { width: height, height: width }
            : { width, height };
    } catch (err) {
        console.warn(`Could not read dimensions of ${filePath}: ${err.message}`);
        return null;
    } finally {
        await handle?.close();
    }
}

/* Sets width/height on each node (NULL when unmeasurable), `concurrency` files at a time. */
const measureLocalNodes = async (nodes: localFileNode[], concurrency: number = 8): Promise<void> => {
    for (let i = 0; i < nodes.length; i += concurrency) {
        await Promise.all(nodes.slice(i, i + concurrency).map(async node => {
            const dims = await readDimensions(node.source, node.extension);
            node.width = dims?.width ?? null;
            node.height = dims?.height ?? null;
        }));
    }
}

export { isMeasurable, readDimensions, measureLocalNodes };
```

Notes:
- `imageSize` throws on an empty buffer, an unknown format, or a header that runs past 512 KB (for example a JPEG with a huge embedded EXIF thumbnail). All of these end up as `NULL`.
- `readDimensions` never throws, so `measureLocalNodes` doesn't need its own try/catch.

## Step 4: Repository (`repository/local.ts`)

1. **`readLocalNodesForDirectory`**: add `width` to the selected columns, so sync can spot unmeasured rows.
2. **`insertLocalNodes`**: add `width, height` to the column list and values: 13 placeholders per row. Update the chunk-size comment (500 × 13 = 6,500, still well under 32,766).
3. **`updateChangedLocalNodes`**: also `SET width = ?, height = ?`. A changed file can have changed dimensions, and a failed measurement correctly writes `NULL`.
4. **New `updateLocalNodeDimensions`** for the backfill:
   ```ts
   /* Stores dimensions for unchanged files that were never measured. */
   const updateLocalNodeDimensions = async (db, localNodes: localFileNode[]) => {
       await runForEach(db,
           `UPDATE ${tableName} SET width = ?, height = ? WHERE source = ?`,
           localNodes,
           node => [node.width, node.height, node.source]
       );
   }
   ```
   Export it.

## Step 5: Sync (`service/localFileService.ts`)

1. **`initializeLocalNode`**: `width: null, height: null` instead of `0`. They're filled in by `measureLocalNodes`, the same way `imageHash` is filled in by `hashLocalNodes`.
2. **Classification loop**: add an `unmeasuredNodes` list. In the "unchanged" branch, as well as the existing URL check:
   ```ts
   if (row.width === null && isMeasurable(node.extension)) {
       unmeasuredNodes.push(node);
   }
   ```
   A node can be in both `urlChangedNodes` and `unmeasuredNodes`. The two updates touch different columns, so that's fine.
3. **Measure after hashing**: measure the nodes that are about to be written:
   ```ts
   await measureLocalNodes([...hashedNew, ...hashedChanged, ...unmeasuredNodes]);
   // only write backfills that found something; the rest are already NULL
   const measuredNodes = unmeasuredNodes.filter(node => node.width !== null);
   ```
   Measuring after hashing means files that failed to hash (and are dropped) aren't measured for nothing.
4. **Transaction**: add `await updateLocalNodeDimensions(db, measuredNodes);` next to the other writes.
5. **Summary log**: add `${measuredNodes.length} measured` to the per-directory line, so the backfill shows up on the first start and the count drops to 0 afterwards.

## Step 6: Media read path

- **`repository/media.ts` → `getMedia`**: add `Local.width, Local.height` to the SELECT.
- **`service/mediaService.ts` → `getMediaNodes`**: `width: row.width, height: row.height`.
- `populateMediaFromSource`: no change (see Decisions).

---

## Verification

There's no test suite, so this is checked by hand against a real database.

1. **Back up** `db/media.sqlite3` first (migration 2 can't be undone without the backup).
2. `npm run build` compiles cleanly.
3. **Migration + backfill (existing files):** `npm start` against the existing database.
   - The log shows `Migrating database schema to version 2`, and each directory reports `N measured` with N ≈ its image count.
   - `PRAGMA user_version` is `2`.
   - `SELECT extension, COUNT(*), SUM(width IS NULL) FROM Local GROUP BY extension` shows images with dimensions and `mp4`/`webm` all `NULL`.
4. **Spot-check correctness:** compare a few rows with their real dimensions, including a rotated phone JPEG (orientation 6) and a GIF.
5. **Second start:** each directory reports `0 measured` (or only the known-unreadable files), and no re-hashing happens.
6. **New file:** add an image to a watched directory and restart. It's reported as new, and its row has correct dimensions.
7. **Changed file:** overwrite an image with one of a different size and restart. Its row is updated with the new dimensions.
8. **Unreadable file:** a corrupt or zero-byte `.jpg` gets inserted with `NULL` dimensions and a warning, and startup carries on.
9. **Fresh database:** delete (after backing up) `media.sqlite3` and start. Migrations 1→2 run, and every row is measured on insert.
10. **API:** `GET /media` returns real `width`/`height` for images and `null` for videos.

## Files touched

- `repository/schema.ts`: version 2, migration 2
- `entity/localFileNode.ts`, `entity/mediaNode.ts`: nullable dimensions
- `service/dimensionService.ts`: **new**
- `repository/local.ts`: select/insert/update width and height, new `updateLocalNodeDimensions`
- `service/localFileService.ts`: null defaults, backfill classification, measure step
- `repository/media.ts`: `getMedia` selects dimensions
- `service/mediaService.ts`: pass dimensions through
