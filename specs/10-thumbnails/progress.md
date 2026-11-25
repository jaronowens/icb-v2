# Progress: Thumbnails

Plan: `specs/10-thumbnails/implementation.md`. Times are local.

| Task | Model / effort | Status | Started | Finished | Duration | Tokens |
| --- | --- | --- | --- | --- | --- | --- |
| Step 1: compute `previewURL`, migration 5 | Sonnet / medium | done | 2026-11-24 21:28 | 2026-11-24 21:30 | 2m 37s | 89,384 |
| Step 2: thumbnail service and limiter | Opus / high | done | 2026-11-24 21:28 | 2026-11-24 21:33 | 5m 36s | 121,005 |
| Step 3: `/thumbnails` fallback and wiring | Sonnet / medium | done | 2026-11-24 21:34 | 2026-11-24 21:36 | 2m 06s | 72,813 |
| Step 4: background job, `onIdle`, status | Sonnet / high | done | 2026-11-24 21:37 | 2026-11-24 21:40 | 3m 28s | 97,071 |
| Step 5: verification and quality | Main session (Opus 5.5) | done | 2026-11-24 21:42 | 2026-11-24 21:45 | ~3m | not reported separately: part of the main session |

**Total, Steps 1–4 (subagents):** 13m 47s of agent time, 380,273 tokens. Wall-clock time from 21:28 to 21:45 was about 17 minutes, including the main session's merges, reviews and Step 5.

## Log
- 21:28: Steps 1 and 2 started in parallel.
- 21:30: Step 1 done.
  - Migration 5 is in, and `previewURL` is now computed for both `GET /media` and `files[]`. `thumbnails` is a reserved directory name.
  - Its own tests pass. The 5 remaining failures come from Step 2's new fixture changing Media counts, which Step 2 owns.
  - **Bug fixed:** after `imageHash` was added to the `files[]` query, spreading the row put `source` before `previewURL`. The existing key-order test caught it, and the entries are now built with explicit keys.
- 21:33: Step 2 done.
  - Added the limiter, the thumbnail service, `jobStatus.ts`, and the `exif-rotated.jpg` fixture.
  - Count updates for the new fixture: `startupService.test.ts` (Media 15 → 16, plus the DIMENSIONS entry), `media.test.ts` (15 → 16), and `tags.test.ts` (`claude` 6 → 7 and 7 → 8). `fixtures/tags.ts` gained an entry.
  - **Bug fixed:** the limiter freed its slot in `.finally()`, after the caller resumed, so `active()` was stale. Its own test caught it.
  - **Deviation:** the pipeline uses `.toBuffer()` plus `writeFile` instead of `.toFile()`, so disk errors aren't reported as decode errors.
- 21:33: Main session check after merging Steps 1 and 2: both `tsc` checks are clean, and 254 tests pass, 0 failing.
- 21:34: Step 3 started.
- 21:36: Step 3 done.
  - Added the `/thumbnails` static mount, `thumbnailFallback`, `getThumbnailSource`, the test helper's `thumbnails` and `thumbnailJob` factories, and a mocha root hook that deletes the temp folders.
  - **Deviation:** `bin/www.ts` now creates the thumbnail service, because `createApp` requires it.
  - Main session check: 265 passing, `tsc` clean.
- 21:37: Main session fix: the fallback's size pattern accepted leading zeros, so `-0900.webp` was a second URL for the same thumbnail. It's now `[1-9]\d*`.
- 21:37: Step 4 started.
- 21:40: Step 4 done.
  - Added `createThumbnailJob`, `getMediaNeedingThumbnail`, the perceptual hash job's `onIdle`, `/status` `thumbnails`, and the `bin/www.ts` wiring.
  - 277 passing, three runs in a row.
  - **Deviation:** `createThumbnailJob` takes an optional `{ onPassEnd }` for counting passes in tests.
- 21:41: Main session fix: the job's query hard-coded `'none'`. It now takes `UNHASHABLE` as a parameter, as `getMediaNeedingPerceptualHash` does. 277 passing, `tsc` clean.
- 21:41: Main session note (pre-existing, not changed): `getFileExtension` doesn't lowercase, so files like `photo.JPG` are never imported at all. Thumbnails match that, because only lowercase extensions ever reach the database.
- 21:42: Step 5 started.
- 21:44: Step 5 done.
  - Fresh real-data run: 652 thumbnails in 42.6 s, starting right after the perceptual hash pass. They take 45.2 MB, 6.5% of the 699.9 MB of originals, and all 670 `previewURL`s answer `200`.
  - A restart makes nothing. A cold grid of 24 tiles comes back in 1.8 s.
  - `npm run build` passes. Quality samples were written for the user to compare. The full results are in `implementation.md` under "Measurements".
- The user chose WebP quality 80, so the code doesn't change.
