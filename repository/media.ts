import { TagTerm, MediaSearch } from '../entity/mediaSearch';

const tableName: string = 'Media';

/**
 * A Media row's tag names as a JSON array, sorted by name ('[]' if it has none). Used as a column in queries on Media.
 * json_group_array keeps tags that contain commas intact, which GROUP_CONCAT wouldn't.
 */
const TAGS_COLUMN: string = `(
    SELECT json_group_array(name) FROM (
        SELECT Tags.name AS name FROM Media_Tags JOIN Tags ON Tags.id = Media_Tags.tagID
        WHERE Media_Tags.mediaID = Media.id
        ORDER BY Tags.name)
) AS tags`;

/* Table names can't be bound as SQL parameters, so only allow known source tables to be interpolated. */
const SOURCE_TABLES: string[] = ['Local'];

const assertSourceTable = (sourceTable: string) => {
    if (!SOURCE_TABLES.includes(sourceTable)) {
        throw new Error(`Unsupported source table: ${sourceTable}`);
    }
}

/**
 * Creates one Media row for each distinct image hash in the source table that doesn't have one yet.
 * The file with the lowest id for each hash becomes the Media row's representative (sourceID).
 */
const populateMediaFromSource = async (sourceTable: string, db) => {
    assertSourceTable(sourceTable);
    console.log('creating media nodes for new image hashes from', sourceTable);

    const query = `
        INSERT INTO ${tableName} (type, isMounted, imageHash, sourceID, mediaCollectionID, userDataID)
        SELECT ?, 1, imageHash, MIN(id), NULL, NULL
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
                SELECT Media.id
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

/**
 * Points every Media row at the lowest-id Local file that still has its hash, or NULL if there are none.
 * Runs over all Media each start: one indexed query is cheaper than tracking which rows went stale.
 */
const refreshMediaSources = async (db) => {
    // IS NOT handles NULLs, so only rows whose representative actually changed are written
    const result = await db.run(`
        UPDATE ${tableName}
        SET sourceID = (SELECT MIN(Local.id) FROM Local WHERE Local.imageHash = Media.imageHash)
        WHERE sourceID IS NOT (SELECT MIN(Local.id) FROM Local WHERE Local.imageHash = Media.imageHash);
    `);
    console.log(`Re-pointed sources for ${result.changes} media nodes.`);
}

/* Escapes LIKE's wildcards (and the escape character itself) so the input matches literally. Use with ESCAPE '\'. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

/* One tag term as an (NOT) EXISTS over the Media row's tags. The tag name is bound by the caller. */
const tagTermClause = (term: TagTerm): string => `${term.negated ? 'NOT ' : ''}EXISTS (
            SELECT 1 FROM Media_Tags JOIN Tags ON Tags.id = Media_Tags.tagID
            WHERE Media_Tags.mediaID = Media.id AND Tags.name = ?)`;

/**
 * Returns one entry per mounted Media row that matches every filter in `search`, using its representative Local file
 * for names and URLs, ordered by id. With no filters it returns every mounted row.
 * Only fixed SQL text is interpolated: every value from `search` is bound.
 */
const getMedia = async (db, search: MediaSearch = {}) => {
    const where: string[] = ['Media.isMounted = 1'];
    const params: unknown[] = [];

    // name, extension and is_video match the representative file (Media.sourceID) only, not every duplicate
    // behind the row. That's documented in README.md; searching all files is a planned option.
    if (search.name !== undefined) {
        // LIKE folds case for ASCII letters only
        where.push(`Local.name LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(search.name)}%`);
    }
    if (search.extensions !== undefined) {
        where.push(`Local.extension IN (${search.extensions.map(() => '?').join(', ')})`);
        params.push(...search.extensions);
    }
    if (search.isVideo !== undefined) {
        // BOOL has NUMERIC affinity, so the JS booleans written by insertLocalNodes are stored as 1/0
        where.push('Local.is_video = ?');
        params.push(search.isVideo ? 1 : 0);
    }
    if (search.hash !== undefined) {
        where.push('Media.imageHash = ?');
        params.push(search.hash);
    }
    // terms in a group are ORed; the groups are ANDed with everything else
    for (const group of search.tags ?? []) {
        where.push(`(${group.map(term => {
            params.push(term.name);
            return tagTermClause(term);
        }).join(' OR ')})`);
    }

    let limit = '';
    if (search.count !== undefined) {
        limit = 'LIMIT ?';
        params.push(search.count);
    }

    return db.all(`
        SELECT Media.id AS id, Media.imageHash, ${TAGS_COLUMN},
               Local.name, Local.extension, Local.is_video, Local.imageURL, Local.previewURL, Local.source,
               Local.width, Local.height
        FROM ${tableName}
        JOIN Local ON Local.id = Media.sourceID
        WHERE ${where.join('\n          AND ')}
        ORDER BY Media.id
        ${limit};
    `, params);
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
/* One Media row with its representative Local file's fields, or undefined. The Local fields are NULL if it has no source. */
const getMediaById = async (db, id: number) => {
    return db.get(`
        SELECT Media.id AS id, Media.imageHash, ${TAGS_COLUMN}, Media.isMounted,
               Local.name, Local.extension, Local.is_video, Local.imageURL, Local.previewURL, Local.source,
               Local.width, Local.height
        FROM ${tableName}
        LEFT JOIN Local ON Local.id = Media.sourceID
        WHERE Media.id = ?;
    `, [id]);
}

/* Every unmounted Media row, with only the fields the Media row itself has. */
const getUnmountedMedia = async (db) => {
    return db.all(`SELECT Media.id AS id, Media.imageHash, ${TAGS_COLUMN} FROM ${tableName} WHERE Media.isMounted = 0 ORDER BY Media.id`);
}

const mediaExists = async (db, id: number): Promise<boolean> => {
    return !!(await db.get(`SELECT 1 FROM ${tableName} WHERE id = ?`, [id]));
}

const getMediaByHash = async (db, imageHash: string) => {
    return db.get(`SELECT id, isMounted FROM ${tableName} WHERE imageHash = ?`, [imageHash]);
}

/* Creates a mounted Media row for a Local file, with the same column values populateMediaFromSource uses. Returns its id. */
const insertMedia = async (db, imageHash: string, sourceID: number): Promise<number> => {
    const result = await db.run(
        `INSERT INTO ${tableName} (type, isMounted, imageHash, sourceID, mediaCollectionID, userDataID) VALUES ('Local', 1, ?, ?, NULL, NULL)`,
        [imageHash, sourceID]
    );
    return result.lastID;
}

/* Mounts a Media row and points it at the lowest-id Local file with its hash, as startup sync does. */
const mountMedia = async (db, id: number) => {
    await db.run(`
        UPDATE ${tableName}
        SET isMounted = 1,
            sourceID = (SELECT MIN(Local.id) FROM Local WHERE Local.imageHash = Media.imageHash)
        WHERE id = ?;
    `, [id]);
}

/**
 * Mounted Media rows whose representative file is one of `types` and whose perceptual hash is missing or was made
 * with other settings (doesn't start with `prefix`). Rows marked `unhashable` are skipped.
 */
const getMediaNeedingPerceptualHash = async (db, types: string[], prefix: string, unhashable: string): Promise<{ id: number, source: string }[]> => {
    const placeholders = types.map(() => '?').join(', ');
    return db.all(`
        SELECT Media.id AS id, Local.source AS source
        FROM ${tableName}
        JOIN Local ON Local.id = Media.sourceID
        WHERE Media.isMounted = 1
          AND lower(Local.extension) IN (${placeholders})
          AND (Media.perceptualHash IS NULL
               OR (Media.perceptualHash != ? AND substr(Media.perceptualHash, 1, ?) != ?))
        ORDER BY Media.id;
    `, [...types, unhashable, prefix.length, prefix]);
}

/* Stores perceptual hashes. Doesn't open its own transaction: the caller runs it inside one. */
const setPerceptualHashes = async (db, results: { id: number, value: string }[]) => {
    if (results.length === 0) {
        return;
    }
    const statement = await db.prepare(`UPDATE ${tableName} SET perceptualHash = ? WHERE id = ?`);
    try {
        for (const { id, value } of results) {
            await statement.run([value, id]);
        }
    } finally {
        await statement.finalize();
    }
}

export {
    getMediaNeedingPerceptualHash,
    setPerceptualHashes,
    populateMediaFromSource,
    syncUnlinkedLocalNodes,
    refreshMediaSources,
    getMedia,
    synchronizeMedia,
    getMediaById,
    getUnmountedMedia,
    getMediaByHash,
    mediaExists,
    insertMedia,
    mountMedia,
};
