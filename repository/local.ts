import { localFileNode } from "../entity/localFileNode";
const tableName: string = 'Local';

/* Rows per statement. 500 rows * 12 columns stays well under SQLite's bound-parameter limit (32766). */
const CHUNK_SIZE: number = 500;

/* Local rows for one directory, with just the columns startup sync needs to classify files. */
const readLocalNodesForDirectory = async (db, directoryPath: string) => {
    return db.all(
        `SELECT id, source, size, mtimeMs, imageHash, imageURL, width FROM ${tableName} WHERE directoryPath = ?`,
        [directoryPath]
    );
}

/* Inserts new nodes as unlinked (mediaID = -1). Doesn't open its own transaction: the caller runs it inside one. */
const insertLocalNodes = async (db, localNodes: localFileNode[]) => {
    for (let i = 0; i < localNodes.length; i += CHUNK_SIZE) {
        const chunk = localNodes.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const query = `INSERT INTO ${tableName} (name, extension, is_video, directoryPath, source, imageURL, size, mtimeMs, imageHash, width, height, mediaID) VALUES ${placeholders}`;

        const values = chunk.flatMap(node => [
            node.name,
            node.extension,
            node.is_video,
            node.directoryPath,
            node.source,
            node.imageURL,
            node.size,
            node.mtimeMs,
            node.imageHash,
            node.width,
            node.height,
            -1
        ]);
        await db.run(query, values);
    }
};

/* Runs one prepared statement for each item, then finalizes it. */
const runForEach = async <T>(db, query: string, items: T[], params: (item: T) => any[]) => {
    if (items.length === 0) {
        return;
    }
    const statement = await db.prepare(query);
    try {
        for (const item of items) {
            await statement.run(params(item));
        }
    } finally {
        await statement.finalize();
    }
}

/* Stores a re-hashed file's new hash, size, mtime, dimensions and URL, and unlinks it so it gets re-linked to Media. */
const updateChangedLocalNodes = async (db, localNodes: localFileNode[]) => {
    await runForEach(db,
        `UPDATE ${tableName} SET name = ?, imageURL = ?, imageHash = ?, size = ?, mtimeMs = ?, width = ?, height = ?, mediaID = -1 WHERE source = ?`,
        localNodes,
        node => [node.name, node.imageURL, node.imageHash, node.size, node.mtimeMs, node.width, node.height, node.source]
    );
}

/* Updates names and URLs for unchanged files whose directory `name` changed. */
const updateLocalNodeURLs = async (db, localNodes: localFileNode[]) => {
    await runForEach(db,
        `UPDATE ${tableName} SET name = ?, imageURL = ? WHERE source = ?`,
        localNodes,
        node => [node.name, node.imageURL, node.source]
    );
}

/* Stores dimensions for unchanged files that were never measured. */
const updateLocalNodeDimensions = async (db, localNodes: localFileNode[]) => {
    await runForEach(db,
        `UPDATE ${tableName} SET width = ?, height = ? WHERE source = ?`,
        localNodes,
        node => [node.width, node.height, node.source]
    );
}

const deleteLocalNodes = async (db, sources: string[]) => {
    for (let i = 0; i < sources.length; i += CHUNK_SIZE) {
        const chunk = sources.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        await db.run(`DELETE FROM ${tableName} WHERE source IN (${placeholders})`, chunk);
    }
}

/* Deletes rows from directories that are no longer in directories.json. An empty list deletes every row. */
const deleteLocalNodesOutsideDirectories = async (db, directoryPaths: string[]) => {
    let result;
    if (directoryPaths.length === 0) {
        result = await db.run(`DELETE FROM ${tableName}`);
    } else {
        const placeholders = directoryPaths.map(() => '?').join(', ');
        result = await db.run(`DELETE FROM ${tableName} WHERE directoryPath NOT IN (${placeholders})`, directoryPaths);
    }
    if (result.changes > 0) {
        console.log(`Removed ${result.changes} local nodes from directories no longer in directories.json`);
    }
}

const readLocalNodes = async (db) => {
    return (await db.all(`SELECT * from ${tableName}`));
}

/* Every Local file linked to a Media row, lowest id (the representative) first. */
const getLocalNodesForMedia = async (db, mediaID: number) => {
    return db.all(
        `SELECT id, name, extension, is_video, imageURL, imageHash, source FROM ${tableName} WHERE mediaID = ? ORDER BY id`,
        [mediaID]
    );
}

const getLocalNodeBySource = async (db, source: string) => {
    return db.get(`SELECT id, mediaID FROM ${tableName} WHERE source = ?`, [source]);
}

const linkLocalNode = async (db, localID: number, mediaID: number) => {
    await db.run(`UPDATE ${tableName} SET mediaID = ? WHERE id = ?`, [mediaID, localID]);
}

export {
    readLocalNodesForDirectory,
    insertLocalNodes,
    updateChangedLocalNodes,
    updateLocalNodeURLs,
    updateLocalNodeDimensions,
    deleteLocalNodes,
    deleteLocalNodesOutsideDirectories,
    readLocalNodes,
    getLocalNodesForMedia,
    getLocalNodeBySource,
    linkLocalNode,
};
