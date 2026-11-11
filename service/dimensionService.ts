import { open } from 'node:fs/promises';
import { imageSize } from 'image-size';
import { localFileNode } from '../entity/localFileNode';

/* File types image-size can read. Everything else (videos) is stored with NULL dimensions. */
const MEASURABLE_TYPES: string[] = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
/* Same limit image-size's own imageSizeFromFile uses: headers are near the start of the file.
   (image-size/fromFile isn't used because it doesn't resolve under this project's moduleResolution.) */
const MAX_HEADER_BYTES: number = 512 * 1024;
/* EXIF orientations 5-8 rotate the image 90 or 270 degrees, so the displayed width and height are swapped. */
const ROTATED_ORIENTATIONS: number[] = [5, 6, 7, 8];

const isMeasurable = (extension: string): boolean => MEASURABLE_TYPES.includes(extension.toLowerCase());

/* Reads the header of the file and returns its displayed dimensions, or null if it can't be measured. Never throws. */
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
