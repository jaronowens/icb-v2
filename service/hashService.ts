import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { localFileNode } from '../entity/localFileNode';

/* Every file's identity hash is a sha256 of its bytes. Perceptual hashes are separate: see perceptualHashService.ts. */
const SHA256_PREFIX: string = 'sha256:';
const PROGRESS_INTERVAL: number = 100;

/* The hex sha256 of a file's bytes, without the prefix. */
const sha256File = (filePath: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(filePath)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });
}

/* Hashes a file, returning `sha256:<hex>`. */
const computeFileHash = async (filePath: string): Promise<string> => {
    return `${SHA256_PREFIX}${await sha256File(filePath)}`;
}

/* True if the hash is a current identity hash. Hashes from before sha256 identity (`phash...:`) are out of date. */
const isCurrentHash = (hash: string): boolean => {
    return hash.startsWith(SHA256_PREFIX);
}

/**
 * Sets imageHash on each node, hashing `concurrency` files at a time so file reads overlap.
 * Returns only the nodes that were hashed successfully.
 */
const hashLocalNodes = async (nodes: localFileNode[], concurrency: number = 8): Promise<localFileNode[]> => {
    for (let i = 0; i < nodes.length; i += concurrency) {
        const slice = nodes.slice(i, i + concurrency);
        await Promise.all(slice.map(async node => {
            try {
                node.imageHash = await computeFileHash(node.source);
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

export { computeFileHash, hashLocalNodes, isCurrentHash, sha256File, SHA256_PREFIX };
