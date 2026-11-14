> **Updated by `specs/background-perceptual-hash/`:** files now share a Media row only when their bytes are identical (sha256). Perceptual hashes live in their own column, `Media.perceptualHash`, filled in by a background job, and no longer merge anything. Resized and re-compressed copies are therefore always separate Media rows until near-match review merges them. The sections below have been updated to match.

After the image-hash conversion (`specs/convert-to-image-hash/`), two files shared a Media row only when their perceptual hashes were **exactly** equal. That was deliberately strict: testing showed that loosening it merges alternate versions of an artwork (the same base drawing with clothing, effects or text changed) along with true duplicates. As a result, about a third of resized or re-compressed duplicates were missed and stayed as separate Media rows. Alternate versions also have no relationship to each other at all.

This spec adds **near-match comparison**: find pairs of images whose hashes are *close* but not equal, and let the user decide what each pair is. The app doesn't decide.

## Depends on
- **The image-hash conversion** (done), as reworked by **`specs/background-perceptual-hash/`** (done): `Media.imageHash` is always `sha256:<hex>`. `Media.perceptualHash` is `phash16:<hex>` (a 256-bit blockhash, decoded with `sharp`), `none` for images that couldn't be decoded, or `NULL` for gifs, videos and images not hashed yet.
- **Database persistence** (the second half of `specs/convert-to-image-hash/spec.md`): review decisions are user data. While the tables are dropped on every start, every decision would be lost on restart. This spec shouldn't ship before persistence does.

## Background: why near-match can't auto-merge
Measured during the image-hash work, with `image-hash` decoding at full size. "Distance" is the Hamming distance, the number of bits that differ between two hashes. The app now decodes with `sharp` and shrinks images to 512 px first; on `duplicates-test` that moves a few pairs by 2–4 bits (3/22 goes from 38 to 40) and leaves the closest unrelated pair at 68. See "Measurements" in `specs/background-perceptual-hash/implementation.md`.

| Pair type | Distance at 16 bits (of 256) | Distance at 8 bits (of 64) |
| --- | --- | --- |
| Resized copy (half size, JPEG quality 60), 30 photos | 0–9 (19/30 are 0) | 0–2 (27/30 are 0) |
| Alternate versions, 19 pairs in 13 sets | 2–38 (18/19 are ≤ 16; the outlier, 3/22, is 38) | 0–8 |
| Same character, different picture (6 pairs) | 84–156 | 18–40 |
| All other pairs (722) | closest 68, median 121 | closest 12, median 30 |

The ranges for resized copies and alternates overlap, so no threshold can tell them apart. A simple pixel comparison (% of areas that differ at a common size) overlaps too: resized copies differed in up to 3.8%, some alternates in as little as 1.2%. **But both kinds are clearly separated from unrelated images.** That makes the hash good at *finding candidates*, and a person decides which kind each one is.

## Goals
1. Find pairs of Media whose perceptual hashes are within a distance threshold, and store them as candidates.
2. Let the user label each candidate pair as `duplicate`, `alternate` or `not_related`, and never ask about a pair again once it's labeled.
3. Labeling a pair `duplicate` merges the two Media rows into one.
4. Labeling a pair `alternate` links them into an **alternate group**, so the API can return "other versions" of an image.

## Non-goals
- Deciding anything automatically. Nothing is merged without a user decision.
- Building the review UI. This spec covers the API; the front end is separate.
- Near-matching gifs and videos. They have no perceptual hash (`perceptualHash` is `NULL`), so only `phash16:` rows take part.

## Spec

### Finding candidates
- Compare every Media row whose `perceptualHash` starts with `phash16:` against every other, compute the Hamming distance, and record a candidate for each pair where `0 <= distance <= threshold`. Distance 0 is included: identical perceptual hashes no longer merge automatically, so they need a decision like any other pair. Skip `none` and `NULL`.
- The threshold is a single config value. **Starting point: 40** (of 256 bits). In testing, that catches every alternate pair (the farthest was 38, now exactly 40 with `sharp`) and every resized copy (the farthest was 9), while the closest unrelated pair was 68. A threshold of 16 would miss 1 of the 19 alternate pairs. Since 3/22 now sits right at 40 and nothing unrelated comes closer than 68, a little margin (say 44) may be worth it. Tune it with real data.
- SQLite can't count differing bits in hex strings, so the comparison runs in JS.
  - **Simple approach (fine up to a few thousand images):** compare every pair. 670 images is about 224,000 comparisons, which takes well under a second.
  - **Scaling approach (if the collection grows into tens of thousands):** split each 256-bit hash into *k* chunks, where *k* is greater than the threshold, and store them in an indexed table. If two hashes are within the threshold, at least one chunk must be identical (the pigeonhole principle). So only images that share a chunk need comparing, and that lookup is a plain indexed SQL join. Caveat: with a threshold of 40, that means 41+ chunks of about 6 bits each. Chunks that small match by chance often, so the index filters out very little. A BK-tree (a search tree built on distances) or a lower threshold may work better. Optional; only worth it if the simple approach gets slow.
- Run this after a background perceptual hash pass finishes (`service/perceptualHashService.ts`), not after startup sync: until then, new rows have no perceptual hash. Only check pairs involving Media rows hashed since the last run; previously checked pairs don't need recomputing.

### Storage
New table (the names are suggestions):

```sql
CREATE TABLE MediaSimilarity (
    mediaA    INT NOT NULL,      -- always the lower Media rowid, so each pair is stored once
    mediaB    INT NOT NULL,
    distance  INT NOT NULL,
    status    TEXT NOT NULL DEFAULT 'unreviewed',  -- unreviewed | duplicate | alternate | not_related
    reviewedAt TEXT,
    PRIMARY KEY (mediaA, mediaB),
    CHECK (mediaA < mediaB)
);
```

Alternate groups need their own representation. One option is an `alternateGroupID` column on Media. Another is an `AlternateGroups` table plus a join table. See open questions.

### Actions
- **`duplicate`:** merge the two Media rows. Pick a survivor (the open questions cover which), move every `Local.mediaID` that points at the other row over to it, combine tags, and delete the other row. Any `MediaSimilarity` rows that pointed at the deleted Media are re-pointed or removed.
- **`alternate`:** put both Media rows into the same alternate group. If one is already in a group, the other joins it; if both are in different groups, the groups merge.
- **`not_related`:** only record the decision, so the pair is never suggested again.
- A decision can be undone, except that undoing a `duplicate` merge may not be fully possible (see open questions).

### API (under `/media`)
- `GET /media/similar?status=unreviewed`: list candidate pairs, closest first, with both images' URLs and the distance.
- `PUT /media/similar/:mediaA/:mediaB` with body `{ "status": "duplicate" | "alternate" | "not_related" }`: record a decision and apply its action.
- `GET /media/:id/alternates`: list the other Media rows in this image's alternate group.

## Test data
- **`F:\Thunder\Documents\Salvaged Downloads\hydrus-export\duplicates-test`**: 39 images. The ground truth below was found by looking at every hash cluster; the two pairs that looked identical (11/31, 1/39) were also checked with pixel difference maps. **All of these are alternates; the folder has no true duplicates.**
  - Alternate sets: {1, 39}, {2, 29}, {3, 22}, {4, 7}, {5, 9, 24}, {6, 23, 36}, {10, 11, 31}, {12, 32}, {15, 30}, {17, 28}, {18, 38}, {19, 26}, {27, 35}
  - Same character in a *different* picture, which should **not** be matched: {20, 25, 34, 37}
  - Unrelated: 8, 13, 14, 16, 21, 33
  - Expected with threshold 40: all 19 pairs inside alternate sets become candidates, and nothing else does (the closest other pair is 68). With threshold 16: 18 of 19 (3/22 is missed at 40).
- **`F:\Thunder\Documents\Salvaged Downloads\hydrus-export\highly-rated`**: 670 images, already filtered for duplicates and close near-matches, so it should produce very few candidates. Good for checking false positives.
- **Real duplicates:** neither folder contains real resized or re-compressed duplicates. A test set of genuine internet re-uploads (different sizes or compression of the same image) would make threshold tuning far more trustworthy than synthetic downscales.
- **`tools/pairwise-distances.js`**: hashes a folder at 8 and 16 bits with `image-hash` and prints the closest pairs. This is the script used to produce the measurements above. For the app's current pipeline, use `specs/background-perceptual-hash/tools/compare-decoders.ts --pairs`.

## Open questions
- **Which Media survives a `duplicate` merge?** Larger resolution? Larger file? The older row? Or should the user pick in the request?
- **Can a `duplicate` merge be undone?** If the merged-away row is deleted, its separate tags are lost. One option is a soft-merge: keep the row and add a `mergedInto` pointer.
- **Should duplicate files be deleted from disk?** Probably not by this app, since the directories are read-only sources, but the response could flag them.
- **How should alternate groups be stored?** A column on Media or a separate table. A separate table makes it easier to add group metadata (a "primary" version, a name) later.
- **Should `/media` hide all but one image per alternate group?** Possibly as a query option.
- **Does the threshold need to depend on image size or type?** No evidence yet; revisit once there's real-duplicate test data.
