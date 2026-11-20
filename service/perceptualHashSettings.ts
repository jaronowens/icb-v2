/*
 * Perceptual hash settings, shared by the background job and its workers (specs/07-background-perceptual-hash).
 * Perceptual hashes are stored in Media.perceptualHash and never decide which Media row a file belongs to.
 */

/* File types sharp decodes for perceptual hashing. Everything else keeps perceptualHash NULL. */
const PERCEPTUAL_TYPES: string[] = ['jpg', 'jpeg', 'png', 'webp'];
/* 16 bits per row = 256-bit hash. 8 bits caught more resized copies but also merged alternate versions of the same artwork
   (see specs/01-convert-to-image-hash/implementation.md), so the finer hash is used. */
const HASH_BITS: number = 16;
/* The bit count is part of the prefix, so hashes made with different settings never match each other. */
const PHASH_PREFIX: string = `phash${HASH_BITS}:`;
/* Stored for images that couldn't be decoded, so they aren't retried on every pass. */
const UNHASHABLE: string = 'none';
/* Longest side images are shrunk to before hashing, or null to hash at full size. Measured in
   specs/07-background-perceptual-hash/implementation.md: about 3x faster on large images, and the near-match ground truth still holds. */
const RESIZE: number | null = 512;

export { PERCEPTUAL_TYPES, HASH_BITS, PHASH_PREFIX, UNHASHABLE, RESIZE };
