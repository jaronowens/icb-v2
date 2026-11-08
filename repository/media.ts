const tableName: string = 'Media';

/* Table names can't be bound as SQL parameters, so only allow known source tables to be interpolated. */
const SOURCE_TABLES: string[] = ['Local'];

const assertSourceTable = (sourceTable: string) => {
    if (!SOURCE_TABLES.includes(sourceTable)) {
        throw new Error(`Unsupported source table: ${sourceTable}`);
    }
}

const initializeMediaDB = async (db, drop: boolean = false) => {
    if (drop) {
        console.log('about to try to drop table if exists, tableName: ', tableName);
        await db.run(`DROP TABLE IF EXISTS ${tableName}`);
    }
    try {
        console.log('creating media table');
        // imageHash is UNIQUE: one Media row per distinct image, shared by every duplicate file
        await db.run(`CREATE TABLE ${tableName} (type TEXT, isMounted BOOL, tags TEXT, imageURL TEXT, imageHash TEXT NOT NULL UNIQUE, sourceID INT, mediaCollectionID INT, userDataID INT,
                FOREIGN KEY (mediaCollectionID) REFERENCES Collections_Media(mediaID),
                FOREIGN KEY (userDataID) REFERENCES UserData(rowid)
                )`);
    } catch (err) {
        console.error(err.message);
    }
}

/**
 * Creates one Media row for each distinct image hash in the source table that doesn't have one yet.
 * The file with the lowest rowid for each hash becomes the Media row's representative (sourceID / imageURL).
 */
const populateMediaFromSource = async (sourceTable: string, db) => {
    assertSourceTable(sourceTable);
    console.log('creating media nodes for new image hashes from', sourceTable);

    // SQLite takes bare columns (imageURL) from the same row MIN(rowid) picked, so the representative is deterministic.
    const query = `
        INSERT INTO ${tableName} (type, isMounted, tags, imageURL, imageHash, sourceID, mediaCollectionID, userDataID)
        SELECT ?, 1, NULL, imageURL, imageHash, MIN(rowid), NULL, NULL
        FROM ${sourceTable}
        WHERE imageHash NOT IN (SELECT imageHash FROM ${tableName})
        GROUP BY imageHash;
    `;

    try {
        const result = await db.run(query, [sourceTable]);
        console.log(`Created ${result.changes} media nodes from ${sourceTable}`);
    }
    catch (err) {
        console.error('Error populating media from source:', err.message);
    }
}

/* Links Local rows to the Media row with the same image hash. Rows with no match keep mediaID = -1. */
const syncUnlinkedLocalNodes = async (db) => {
    try {
        const query = `
            UPDATE Local
            SET mediaID = (
                SELECT Media.rowid
                FROM Media
                WHERE Media.imageHash = Local.imageHash
            )
            WHERE Local.mediaID = -1
              AND EXISTS (SELECT 1 FROM Media WHERE Media.imageHash = Local.imageHash);
        `;
        const result = await db.run(query);
        console.log(`Linked ${result.changes} local nodes to media.`);
    } catch (err) {
        console.error('Error synchronizing unlinked local nodes:', err.message);
    }
};

/* Returns one entry per Media row, using its representative Local file for names and URLs. */
const getMedia = async (db) => {
    const rows = await db.all(`
        SELECT Media.rowid AS id, Media.imageHash, Media.tags,
               Local.name, Local.extension, Local.is_video, Local.imageURL, Local.previewURL, Local.source
        FROM ${tableName}
        JOIN Local ON Local.rowid = Media.sourceID;
    `);

    return rows;
}

const synchronizeMedia = async (db, reset: boolean = true) => {
    if (reset) {
        console.log('resetting all linked files');
        await db.run('UPDATE Media SET isMounted = 0;');
    }

    const query = `
        UPDATE Media
        SET isMounted = 1
        WHERE isMounted = 0
          AND EXISTS (SELECT 1 FROM Local WHERE Local.imageHash = Media.imageHash);
    `;

    const result = await db.run(query);
    console.log(`Media table synchronized, ${result.changes} media nodes mounted.`);
}
export { initializeMediaDB, populateMediaFromSource, syncUnlinkedLocalNodes, getMedia, synchronizeMedia };
