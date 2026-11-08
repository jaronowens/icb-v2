import { localFileNode } from "../entity/localFileNode";
const tableName: string = 'Local';

/* Rows per INSERT statement. 500 rows * 8 columns stays well under SQLite's bound-parameter limit. */
const INSERT_CHUNK_SIZE: number = 500;

const createLocalTable = async (db, drop: boolean = true) => {
    if (drop) {
        console.log('about to try to drop table if exists, tableName: ', tableName);
        await db.run(`DROP TABLE IF EXISTS ${tableName}`);
    }
    try {
        console.log(`creating ${tableName} table`);
        await db.run(`CREATE TABLE ${tableName} (name TEXT, extension TEXT, is_video BOOL, imageURL TEXT UNIQUE, previewURL TEXT, source TEXT, imageHash TEXT NOT NULL, mediaID INT)`);
        // Not unique: duplicate files are allowed here and are merged at the Media level
        await db.run(`CREATE INDEX IF NOT EXISTS idx_local_imageHash ON ${tableName}(imageHash)`);
    }
    catch (err) {
        console.error(`Error creating ${tableName} table: ${err.message}`);
    }
}

const insertLocalNodes = async (directoryPath: string, localNodes: localFileNode[], db) => {
    console.log(`Inserting ${localNodes.length} local nodes from ${directoryPath} into the database.`);
    try {
        await db.run('BEGIN');
        for (let i = 0; i < localNodes.length; i += INSERT_CHUNK_SIZE) {
            const chunk = localNodes.slice(i, i + INSERT_CHUNK_SIZE);
            const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
            const query = `INSERT INTO ${tableName} (name, extension, is_video, imageURL, previewURL, source, imageHash, mediaID) VALUES ${placeholders}`;

            const values = chunk.flatMap(node => [
                node.name,
                node.extension,
                node.is_video,
                node.imageURL,
                node.previewURL,
                node.source,
                node.imageHash,
                -1
            ]);
            await db.run(query, values);
        }
        await db.run('COMMIT');
    } catch (err) {
        console.error('Error performing bulk insert, rolling back:', err.message);
        await db.run('ROLLBACK');
    }
};

const readLocalNodes = async (db) => {
    return (await db.all('SELECT * from Local'));
}


export { createLocalTable, insertLocalNodes, readLocalNodes };
