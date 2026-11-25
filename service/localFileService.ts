import { localFileNode } from "../entity/localFileNode";
import {
    readLocalNodesForDirectory,
    insertLocalNodes,
    updateChangedLocalNodes,
    updateLocalNodeURLs,
    updateLocalNodeDimensions,
    deleteLocalNodes,
} from "../repository/local";
import { hashLocalNodes, isCurrentHash } from "./hashService";
import { isMeasurable, measureLocalNodes } from "./dimensionService";
const BASE_URL: string = 'http://localhost:3000';

const supportedFileTypes: string[] = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm'];

/* Extensions that are the same file type spelled differently. A search for one matches all of them. */
const EXTENSION_ALIASES: string[][] = [['jpg', 'jpeg']];

/* Helpers */
const getFileExtension = (url: string) => {
    const splitUrl = url.split('.');
    const extension = splitUrl.pop();
    if (extension) {
        return extension.split(/\#|\?/)[0];
    }
    return "";
}

const isValidFile = (file: string) => {
    return supportedFileTypes.includes(getFileExtension(file));
}

/* Constructors */
const initializeLocalNode = (fileDir: string, directoryPath: string, fileUrl: string, size: number, mtimeMs: number) => {
    const nodeExtension: string = getFileExtension(fileUrl);
    const newMediaNode: localFileNode = {
        name: fileUrl,
        width: null, // filled in by measureLocalNodes
        height: null,
        extension: nodeExtension,
        is_video: (nodeExtension === 'mp4' || nodeExtension === 'webm') ? true : false,
        imageURL: `${fileDir}/${fileUrl}`,
        imageHash: '', // filled in by hashLocalNodes
        source: `${directoryPath}/${fileUrl}`,
        directoryPath,
        size,
        mtimeMs,
    }
    return newMediaNode;
}

/* Builds a node for each supported file in the directory, with its size and mtime. Throws if the directory can't be read. */
const scanDirectory = (directoryName: string, directoryPath: string, fs): localFileNode[] => {
    const files: string[] = fs.readdirSync(directoryPath);
    const fileDir = `${BASE_URL}/${directoryName}`;
    const nodes: localFileNode[] = [];
    for (const file of files) {
        if (!isValidFile(file)) {
            console.log(`Unsupported filetype, skipping ${file}.`);
            continue;
        }
        let stat;
        try {
            stat = fs.statSync(`${directoryPath}/${file}`);
        } catch (err) {
            // the file disappeared between listing and stat
            console.warn(`Could not read ${directoryPath}/${file}, skipping: ${err.message}`);
            continue;
        }
        if (!stat.isFile()) {
            continue;
        }
        nodes.push(initializeLocalNode(fileDir, directoryPath, file, stat.size, Math.floor(stat.mtimeMs)));
    }
    return nodes;
}

/**
 * Brings the Local rows for one directory up to date with the files on disk:
 * new files are hashed and inserted, changed files are re-hashed and unlinked,
 * unchanged files are left alone (apart from URL updates and measuring files with no dimensions yet),
 * and missing files are deleted.
 *
 * A directory that can't be read (e.g. a drive that isn't connected) is skipped without touching its rows.
 */
const syncDirectory = async (directoryName: string, directoryPath: string, db, fs) => {
    let scanned: localFileNode[];
    try {
        scanned = scanDirectory(directoryName, directoryPath, fs);
    } catch (err) {
        console.error(`Could not read ${directoryPath}, leaving its rows untouched: ${err.message}`);
        return;
    }

    const existing = new Map<string, any>();
    for (const row of await readLocalNodesForDirectory(db, directoryPath)) {
        existing.set(row.source, row);
    }

    const newNodes: localFileNode[] = [];
    const changedNodes: localFileNode[] = [];
    const urlChangedNodes: localFileNode[] = [];
    const unmeasuredNodes: localFileNode[] = [];
    let unchangedCount = 0;
    for (const node of scanned) {
        const row = existing.get(node.source);
        existing.delete(node.source);
        if (!row) {
            newNodes.push(node);
        } else if (row.size !== node.size || row.mtimeMs !== node.mtimeMs || !isCurrentHash(row.imageHash)) {
            changedNodes.push(node);
        } else {
            unchangedCount++;
            if (row.imageURL !== node.imageURL) {
                urlChangedNodes.push(node);
            }
            // rows from before schema version 2, or images that couldn't be read last time
            if (row.width === null && isMeasurable(node.extension)) {
                unmeasuredNodes.push(node);
            }
        }
    }
    // anything left in the map is in the database but no longer on disk
    const missingSources: string[] = [...existing.keys()];

    const toHash = [...newNodes, ...changedNodes];
    if (toHash.length > 0) {
        console.log(`Hashing ${toHash.length} files from ${directoryPath}`);
    }
    // Files that fail to hash are dropped. A changed file that fails keeps its old row,
    // and is tried again next start because its size/mtime still won't match.
    const hashed = new Set(await hashLocalNodes(toHash));
    const hashedNew = newNodes.filter(node => hashed.has(node));
    const hashedChanged = changedNodes.filter(node => hashed.has(node));

    // measured after hashing, so files that failed to hash aren't measured for nothing
    await measureLocalNodes([...hashedNew, ...hashedChanged, ...unmeasuredNodes]);
    // only write backfills that found something; the rest are already NULL
    const measuredNodes = unmeasuredNodes.filter(node => node.width !== null);

    await db.run('BEGIN');
    try {
        await insertLocalNodes(db, hashedNew);
        await updateChangedLocalNodes(db, hashedChanged);
        await updateLocalNodeURLs(db, urlChangedNodes);
        await updateLocalNodeDimensions(db, measuredNodes);
        await deleteLocalNodes(db, missingSources);
        await db.run('COMMIT');
    } catch (err) {
        await db.run('ROLLBACK');
        throw err;
    }

    console.log(`${directoryName}: ${hashedNew.length} new, ${hashedChanged.length} changed, ${unchangedCount} unchanged, ${measuredNodes.length} measured, ${missingSources.length} removed`);
}

export { syncDirectory, initializeLocalNode, isValidFile, getFileExtension, supportedFileTypes, EXTENSION_ALIASES, BASE_URL };
