/*
 * Thumbnail settings and path rules, shared by previewURL, the /thumbnails route and the thumbnail service (specs/10-thumbnails).
 * Pure functions with no sharp import, so the media service can use them without loading sharp.
 */
import { BASE_URL } from "./localFileService";

/* Files with these extensions get a thumbnail. Same types as PERCEPTUAL_TYPES, but kept separate so the two can change on their own. */
const THUMBNAIL_TYPES: string[] = ['jpg', 'jpeg', 'png', 'webp'];

/* Target shortest side in pixels. */
const THUMBNAIL_SIZE: number = 900;

/* The only sizes ever generated, so a request can't make the server create files of any size it likes. */
const THUMBNAIL_SIZES: number[] = [900];

/* The long side is capped at this many times the short side. */
const LONG_SIDE_RATIO: number = 3;

/* Path of a thumbnail inside the thumbnail folder: <aa>/<hex>-<size>.webp, where <aa> is the first two hex characters. */
const thumbnailRelativePath = (hex: string, size: number): string => `${hex.slice(0, 2)}/${hex}-${size}.webp`;

/**
 * The previewURL for a file: its thumbnail for the THUMBNAIL_TYPES, otherwise its own imageURL.
 * It doesn't depend on whether the thumbnail exists yet: /thumbnails makes it on the first request.
 * Unmounted media (null imageURL) have no preview. A hash that isn't sha256 falls back to imageURL rather than a broken URL.
 */
const previewURL = (imageURL: string | null, imageHash: string | null, extension: string | null): string | null => {
    if (imageURL === null) {
        return null;
    }
    if (!THUMBNAIL_TYPES.includes(extension) || !imageHash?.startsWith('sha256:')) {
        return imageURL;
    }
    const hex = imageHash.slice('sha256:'.length);
    return `${BASE_URL}/thumbnails/${thumbnailRelativePath(hex, THUMBNAIL_SIZE)}`;
}

export { THUMBNAIL_TYPES, THUMBNAIL_SIZE, THUMBNAIL_SIZES, LONG_SIDE_RATIO, thumbnailRelativePath, previewURL };
