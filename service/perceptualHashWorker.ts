import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import blockhash, { ImageData } from './blockHash';
import { HASH_BITS, RESIZE } from './perceptualHashSettings';

/* What the job sends a worker, and what the worker sends back. */
type HashRequest = { id: number, source: string };
type HashResponse =
    { id: number, hash: string } |
    { id: number, error: 'read' | 'decode', message: string };

/**
 * Decodes an image with sharp into the RGBA pixels blockhash expects. Throws if sharp can't decode it.
 * `resize`: longest side to shrink to first, or null for full size.
 */
const decodeRGBA = async (buffer: Buffer, resize: number | null): Promise<ImageData> => {
    let image = sharp(buffer);
    if (resize) {
        image = image.resize({ width: resize, height: resize, fit: 'inside', withoutEnlargement: true });
    }
    // Blockhash reads exactly 4 bytes per pixel. srgb turns greyscale and CMYK into RGB, ensureAlpha adds the 4th channel,
    // and uchar keeps 16-bit PNGs at 8 bits. No rotate(): image-hash ignores EXIF orientation, so this does too.
    const { data, info } = await image
        .toColourspace('srgb')
        .ensureAlpha()
        .raw({ depth: 'uchar' })
        .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) {
        throw new Error(`Expected 4 channels after decoding, got ${info.channels}`);
    }
    return { width: info.width, height: info.height, data };
}

/**
 * Returns an image's blockhash as hex (without the prefix). Throws if sharp can't decode it.
 * `resize` defaults to the app's setting.
 */
const hashBuffer = async (buffer: Buffer, { resize = RESIZE }: { resize?: number | null } = {}): Promise<string> => {
    return blockhash(await decodeRGBA(buffer, resize), HASH_BITS, 2);
}

/* Reads and hashes one file. Read and decode failures are reported separately: only decode failures are stored as unhashable. */
const handleRequest = async ({ id, source }: HashRequest): Promise<HashResponse> => {
    let buffer: Buffer;
    try {
        buffer = await readFile(source);
    } catch (err) {
        return { id, error: 'read', message: err.message };
    }
    try {
        return { id, hash: await hashBuffer(buffer) };
    } catch (err) {
        return { id, error: 'decode', message: err.message };
    }
}

// Only wire up messages when running as a worker, so tests can import hashBuffer directly
if (parentPort) {
    // the pool provides the parallelism, and each file is read once, so sharp's own threads and cache would only add overhead
    sharp.concurrency(1);
    sharp.cache(false);
    const port = parentPort;
    port.on('message', async (request: HashRequest) => {
        port.postMessage(await handleRequest(request));
    });
}

export { decodeRGBA, hashBuffer, handleRequest, HashRequest, HashResponse };
