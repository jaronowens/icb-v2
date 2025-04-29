const tableName: string = 'Media';

const initializeMediaDB = async (db, drop: boolean = false) => {
    if (drop) {
        console.log('about to try to drop table if exists, tableName: ', tableName);
        await db.run(`DROP TABLE IF EXISTS ${tableName}`);
    }
    try {
        console.log('creating media table');
        await db.run(`CREATE TABLE ${tableName} (type TEXT, isMounted BOOL, tags TEXT, imageURL TEXT, sourceID INT, mediaCollectionID INT, userDataID INT,
                FOREIGN KEY (mediaCollectionID) REFERENCES Collections_Media(mediaID),
                FOREIGN KEY (userDataID) REFERENCES UserData(rowid)
                )`);
    } catch (err) {
        console.error(err.message);
    }
}

const populateMediaFromSource = async (sourceTable: string, db) => {
    console.log('trying to find unlinked local nodes from', sourceTable);
    // const rows = await db.all(`SELECT * FROM ${sourceTable}`);
    const rows = await db.all(`SELECT Media.ROWID, * from Media FULL JOIN Local ON Media.imageURL = Local.imageURL WHERE Local.mediaID = -1`);
    if (rows.length === 0) {
        console.log(`No unlinked local nodes found in ${sourceTable}`);
        return;
    }
    // constructing bulk query
    /* this feels vaguely hallucinatory to me? like what is the point of mapping a string with no variables? */
    /* the only thing I can think of is that it implicitly draws the length, but i feel like it could just reference rows.length maybe */
    const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const query = `INSERT INTO ${tableName} (type, isMounted, tags, imageURL, sourceID, mediaCollectionID, userDataID) VALUES ${placeholders}`;

    // flatten rows into a single array
    const values = rows.flatMap(row => [
        sourceTable,
        true,
        (row.tags ? row.tags : null),
        row.imageURL,
        row.rowid,
        null,
        null
    ]);

    try {
        console.log(`Creating ${rows.length} media nodes from ${sourceTable}`);
        await db.run(query, values);
    }
    catch (err) {
        console.error('Error performing bulk insert:', err.message);
    }
}

const syncUnlinkedLocalNodes = async (db) => {
    try {
        const query = `
            UPDATE Local
            SET mediaID = (
                SELECT Media.rowid
                FROM Media
                WHERE Media.imageURL = Local.imageURL
            )
            WHERE Local.mediaID = -1;
        `;
        await db.run(query);
        console.log('Unlinked local nodes synchronized successfully.');
    } catch (err) {
        console.error('Error synchronizing unlinked local nodes:', err.message);
    }
};

const getMedia = async (db, sourceTable: string = 'Local',) => {
    const rows = await db.all(`SELECT Media.rowid, * from ${sourceTable} LEFT JOIN ${tableName} ON ${sourceTable}.imageURL = ${tableName}.imageURL`);

    // const rows = await db.all(`SELECT * from Media
    //     FULL JOIN Local
    //         ON Media.imageURL = Local.imageURL
    //     FULL JOIN External
    //         ON Media.imageUrl = External.imageURL
    //     FULl JOIN UserData
    //         ON Media.userDataID = UserData.rowid
    //         `);

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
        WHERE rowid IN (
            SELECT Media.rowid
            FROM Media
            LEFT JOIN Local ON Media.imageURL = Local.imageURL
            WHERE Media.isMounted = 0 AND Local.imageURL IS NOT NULL
        );
    `;

    const result = await db.run(query);
    console.log(`Media table synchronized.`);
}
export { initializeMediaDB, populateMediaFromSource, getMedia, synchronizeMedia, syncUnlinkedLocalNodes };