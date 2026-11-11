# Test fixtures

`images/` is served at `/fixtures` by `createTestApp` (see `test/helpers/index.ts`).

| File | Size | What it covers |
| --- | --- | --- |
| `scene-a.png` | 256×192 | The original image. |
| `scene-a-copy.png` | 256×192 | Byte-for-byte copy of `scene-a.png`: duplicates merge into one Media row. |
| `scene-a-small.png` | 128×96 | `scene-a.png` at half size: gets the same perceptual hash, so it merges too. |
| `checker-b.jpg` | 40×40 | A different image, and the JPEG path. |
| `not-an-image.png` | - | Text with a `.png` extension: dimensions are `NULL` and the hash falls back to sha256. |
| `notes.txt` | - | Unsupported file type: skipped by `syncDirectory`. |

The images were generated, not taken from anywhere. The resized copy only keeps the same hash because both sizes split evenly into the 16×16 hash grid; a 64×48 copy, for example, doesn't merge. If you replace these files, update the tests that depend on them.
