import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import createError from 'http-errors';
import { MediaNode, MediaDetail } from "../entity/mediaNode";
import { localFileNode } from "../entity/localFileNode";
import { getMedia, getMediaById, getUnmountedMedia, getMediaByHash, insertMedia, mountMedia } from "../repository/media";
import { insertLocalNodes, getLocalNodesForMedia, getLocalNodeBySource, linkLocalNode } from "../repository/local";
import { initializeLocalNode, isValidFile, getFileExtension, BASE_URL } from "./localFileService";
import { hashLocalNodes } from "./hashService";
import { measureLocalNodes } from "./dimensionService";
import { withTransaction } from "../util/transaction";
import { parseJsonStringArray, parseMediaSearch } from "../util/queryParams";
import { setMediaTags } from "./tagService";
import { Directory } from "./startupService";

/* A row from getMedia or getMediaById as a GET /media entry. Keeps the key order GET /media has always had. */
const toMediaNode = (row): MediaNode => ({
    id: row.id,
    name: row.name,
    width: row.width,
    height: row.height,
    extension: row.extension,
    // SQLite stores booleans as 1/0; the API answers with a real boolean
    is_video: !!row.is_video,
    source: row.source,
    tags: JSON.parse(row.tags),
    imageURL: row.imageURL,
    imageHash: row.imageHash,
    previewURL: row.previewURL
});

/* An unmounted Media row: only its own fields, with everything that comes from a Local file set to null. */
const unmountedNode = (row): MediaNode => ({
    id: row.id,
    name: null,
    width: null,
    height: null,
    extension: null,
    is_video: null,
    source: null,
    tags: JSON.parse(row.tags),
    imageURL: null,
    imageHash: row.imageHash,
    previewURL: null
});

/**
 * GET /media: the mounted media matching the query parameters in `rawQuery` (see parseMediaSearch), ordered by id.
 * Throws a 400 for a malformed query, and a 404 for a hash that no mounted Media row has. A hash that exists but is
 * ruled out by another filter gives [].
 */
const searchMediaNodes = async (db, rawQuery: Record<string, unknown>): Promise<MediaNode[]> => {
    const search = parseMediaSearch(rawQuery);
    const rows = await getMedia(db, search);
    if (search.hash !== undefined && rows.length === 0) {
        const media = await getMediaByHash(db, search.hash);
        if (!media || !media.isMounted) {
            throw createError(404, `No mounted media with hash ${search.hash}`);
        }
        return [];
    }
    return rows.map(toMediaNode);
}

/* One Media row with every file behind it, or null if there's no such row. */
const getMediaDetail = async (db, id: number): Promise<MediaDetail | null> => {
    const row = await getMediaById(db, id);
    if (!row) {
        return null;
    }
    if (!row.isMounted) {
        return { ...unmountedNode(row), isMounted: false, files: [] };
    }
    const files = (await getLocalNodesForMedia(db, id)).map(file => ({ ...file, is_video: !!file.is_video }));
    return { ...toMediaNode(row), isMounted: true, files };
}

const getUnmountedMediaNodes = async (db) => {
    const rows = await getUnmountedMedia(db);
    return rows.map(row => ({ ...unmountedNode(row), isMounted: false }));
}

/* Windows paths are case-insensitive, so compare them that way there. */
const samePath = (a: string, b: string): boolean => {
    const resolvedA = path.resolve(a);
    const resolvedB = path.resolve(b);
    return process.platform === 'win32'
        ? resolvedA.toLowerCase() === resolvedB.toLowerCase()
        : resolvedA === resolvedB;
}

/**
 * Registers a file that sits directly inside one of the mounted directories, without waiting for the next startup sync.
 * Builds the Local row the same way startup sync does, so the next sync sees it as an unchanged file.
 *
 * Returns the Media id the file belongs to, and whether that Media row was created (a new image)
 * or already existed (a duplicate of a known image, or a file that was already registered).
 * Throws a 400 if the path or file isn't valid.
 */
const addLocalFile = async (db, directories: Directory[], filepath: unknown): Promise<{ id: number, created: boolean }> => {
    if (typeof filepath !== 'string' || filepath.trim() === '') {
        throw createError(400, 'filepath is required');
    }
    const directory = directories.find(directory => samePath(directory.path, path.dirname(filepath)));
    if (!directory) {
        throw createError(400, `File must be directly inside a directory in directories.json: ${filepath}`);
    }
    const fileName = path.basename(filepath);
    if (!isValidFile(fileName)) {
        throw createError(400, `Unsupported file type: .${getFileExtension(fileName)}`);
    }

    let fileStat;
    try {
        fileStat = await stat(filepath);
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
            throw createError(400, `File not found: ${filepath}`);
        }
        throw err;
    }
    if (!fileStat.isFile()) {
        throw createError(400, `Not a file: ${filepath}`);
    }

    // the same values startup sync would build for this file, so `source` matches its format exactly
    const node: localFileNode = initializeLocalNode(
        `${BASE_URL}/${directory.name}`, directory.path, fileName, fileStat.size, Math.floor(fileStat.mtimeMs)
    );
    // skip the hashing for a file that's already registered (checked again inside the lock)
    const registered = await getLocalNodeBySource(db, node.source);
    if (registered) {
        return { id: registered.mediaID, created: false };
    }
    // hashing and measuring are slow, so they happen before taking the write lock
    const [hashed] = await hashLocalNodes([node]);
    if (!hashed) {
        throw createError(400, `Could not read file: ${filepath}`);
    }
    await measureLocalNodes([node]);

    return withTransaction(db, async () => {
        // checked inside the lock, so two requests for the same file can't both insert it
        const existingFile = await getLocalNodeBySource(db, node.source);
        if (existingFile) {
            return { id: existingFile.mediaID, created: false };
        }

        await insertLocalNodes(db, [node]);
        const { id: localID } = await getLocalNodeBySource(db, node.source);

        const existingMedia = await getMediaByHash(db, node.imageHash);
        if (existingMedia) {
            await linkLocalNode(db, localID, existingMedia.id);
            if (!existingMedia.isMounted) {
                await mountMedia(db, existingMedia.id);
            }
            return { id: existingMedia.id, created: false };
        }

        const mediaID = await insertMedia(db, node.imageHash, localID);
        await linkLocalNode(db, localID, mediaID);
        return { id: mediaID, created: true };
    });
}

/**
 * PUT /media/:id: makes the JSON-URL-encoded array in `rawTags` the Media row's complete set of tags, then returns
 * the row as GET /media/:id does. Throws a 400 for a malformed array and a 404 if there's no such row.
 */
const updateMediaTags = async (db, id: number, rawTags: unknown): Promise<MediaDetail> => {
    await setMediaTags(db, id, parseJsonStringArray(rawTags, 'tags'));
    return getMediaDetail(db, id);
}

export { searchMediaNodes, getMediaDetail, getUnmountedMediaNodes, addLocalFile, updateMediaTags };
