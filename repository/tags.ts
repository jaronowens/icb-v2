/*
 * Tags and their links to Media rows (specs/09-tags). Names are stored already normalized (see normalizeTag in
 * service/tagService.ts). None of these open a transaction: the caller runs writes inside withTransaction.
 */

type TagRow = { id: number, name: string };

const getAllTagNames = async (db): Promise<string[]> => {
    const rows = await db.all('SELECT name FROM Tags ORDER BY name');
    return rows.map(row => row.name);
}

const getTagByName = async (db, name: string): Promise<TagRow | undefined> => {
    return db.get('SELECT id, name FROM Tags WHERE name = ?', [name]);
}

/* How many Media rows, mounted or not, are linked to the tag. */
const countMediaForTag = async (db, tagID: number): Promise<number> => {
    const { count } = await db.get('SELECT COUNT(*) AS count FROM Media_Tags WHERE tagID = ?', [tagID]);
    return count;
}

/* Returns the new tag's id. */
const insertTag = async (db, name: string): Promise<number> => {
    const result = await db.run('INSERT INTO Tags (name) VALUES (?)', [name]);
    return result.lastID;
}

const renameTag = async (db, tagID: number, name: string) => {
    await db.run('UPDATE Tags SET name = ? WHERE id = ?', [name, tagID]);
}

/* Deletes the tag and every link to it. */
const deleteTag = async (db, tagID: number) => {
    await db.run('DELETE FROM Media_Tags WHERE tagID = ?', [tagID]);
    await db.run('DELETE FROM Tags WHERE id = ?', [tagID]);
}

/* Re-links every Media row from one tag to another. Rows that already had both end up with one link. */
const moveTagLinks = async (db, fromTagID: number, toTagID: number) => {
    await db.run(
        'INSERT OR IGNORE INTO Media_Tags (mediaID, tagID) SELECT mediaID, ? FROM Media_Tags WHERE tagID = ?',
        [toTagID, fromTagID]
    );
    await db.run('DELETE FROM Media_Tags WHERE tagID = ?', [fromTagID]);
}

const getTagIDsForMedia = async (db, mediaID: number): Promise<number[]> => {
    const rows = await db.all('SELECT tagID FROM Media_Tags WHERE mediaID = ?', [mediaID]);
    return rows.map(row => row.tagID);
}

const linkTag = async (db, mediaID: number, tagID: number) => {
    await db.run('INSERT OR IGNORE INTO Media_Tags (mediaID, tagID) VALUES (?, ?)', [mediaID, tagID]);
}

const unlinkTag = async (db, mediaID: number, tagID: number) => {
    await db.run('DELETE FROM Media_Tags WHERE mediaID = ? AND tagID = ?', [mediaID, tagID]);
}

export {
    TagRow,
    getAllTagNames,
    getTagByName,
    countMediaForTag,
    insertTag,
    renameTag,
    deleteTag,
    moveTagLinks,
    getTagIDsForMedia,
    linkTag,
    unlinkTag,
};
