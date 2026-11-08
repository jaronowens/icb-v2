import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { imageHash } from 'image-hash';
import { localFileNode } from '../entity/localFileNode';

/* File types image-hash can decode. Everything else falls back to a byte-level sha256. */
const PERCEPTUAL_TYPES: string[] = ['jpg', 'jpeg', 'png', 'webp'];
/* 16 bits per row = 256-bit hash. 8 bits caught more resized copies but also merged alternate versions of the same artwork
   (see specs/convert-to-image-hash/implementation.md), so the finer hash is used. */
const HASH_BITS: number = 16;
const PROGRESS_INTERVAL: number = 100;

const sha256File = (filePath: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(filePath)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });
}

/**
 * Hashes a file, returning a prefixed hash string:
 *  - `phash:<hex>` perceptual hash for supported image types
 *  - `sha256:<hex>` content hash for everything else, or if the perceptual hash fails
 */
const computeFileHash = async (filePath: string, extension: string): Promise<string> => {
    if (PERCEPTUAL_TYPES.includes(extension.toLowerCase())) {
        try {
            return `phash:${await imageHash(filePath, HASH_BITS, true)}`;
        } catch (err) {
            console.warn(`Perceptual hash failed for ${filePath}, falling back to sha256: ${err.message}`);
        }
    }
    return `sha256:${await sha256File(filePath)}`;
}

/**
 * Sets imageHash on each node, hashing `concurrency` files at a time.
 * Returns only the nodes that were hashed successfully.
 */
const hashLocalNodes = async (nodes: localFileNode[], concurrency: number = 8): Promise<localFileNode[]> => {
    for (let i = 0; i < nodes.length; i += concurrency) {
        const slice = nodes.slice(i, i + concurrency);
        await Promise.all(slice.map(async node => {
            try {
                node.imageHash = await computeFileHash(node.source, node.extension);
            } catch (err) {
                console.error(`Could not hash ${node.source}, skipping: ${err.message}`);
            }
        }));
        const done = Math.min(i + concurrency, nodes.length);
        if (done % PROGRESS_INTERVAL < concurrency || done === nodes.length) {
            console.log(`Hashed ${done}/${nodes.length} files`);
        }
    }
    // filter rather than push as hashes finish, so the original file order is preserved
    return nodes.filter(node => node.imageHash);
}

export { computeFileHash, hashLocalNodes };
