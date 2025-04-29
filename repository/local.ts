import { localFileNode } from "../entity/localFileNode";
const tableName: string = 'Local';

const createLocalTable = async (db, drop: boolean = true) => {
    if (drop) {
        console.log('about to try to drop table if exists, tableName: ', tableName);
        await db.run(`DROP TABLE IF EXISTS ${tableName}`);
    }
    try {
        console.log(`creating ${tableName} table`);
        await db.run(`CREATE TABLE ${tableName} (name TEXT, extension TEXT, is_video BOOL, imageURL TEXT UNIQUE, previewURL TEXT, source TEXT, mediaID INT)`);
    }
    catch (err) {
        console.error(`Error creating ${tableName} table: ${err.message}`);
    }
}

const insertLocalNodes = async (directoryPath: string, localNodes: localFileNode[], db) => {
    // Construct a single bulk insert query
    const placeholders = localNodes.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const query = `INSERT INTO ${tableName} (name, extension, is_video, imageURL, previewURL, source, mediaID) VALUES ${placeholders}`;

    // Flatten the localNodes array into a single array of values
    const values = localNodes.flatMap(node => [
        node.name,
        node.extension,
        node.is_video,
        node.imageURL,
        node.previewURL,
        node.source,
        -1
    ]);

    try {
        console.log(`Inserting ${localNodes.length} local nodes from ${directoryPath} into the database.`);
        await db.run(query, values);
    } catch (err) {
        console.error('Error performing bulk insert:', err.message);
    }
};

const readLocalNodes = async (db) => {
    return (await db.all('SELECT * from Local')); 
}


export { createLocalTable, insertLocalNodes, readLocalNodes };