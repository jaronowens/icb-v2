import { localFileNode } from "../entity/localFileNode";
import { initializeLocalNodes } from "../service/localFileService";
const BASE_URL: string = 'http://localhost:3000';
const tableName: string = 'Local';

const initializeLocalDB = async (db, drop: boolean = true) => {
    if (drop) {
        console.log('about to try to drop table if exists, tableName: ', tableName);
        await db.run(`DROP TABLE IF EXISTS ${tableName}`);
    }
    console.log('creating table');
    await db.run(`CREATE TABLE ${tableName} (name TEXT, extension TEXT, is_video BOOL, imageURL TEXT UNIQUE, previewURL TEXT, source TEXT, mediaID INT,
        FOREIGN KEY (mediaID) REFERENCES Media(rowid))`);
}

const addLocalNodes = async (directoryName: string, directoryPath: string, db, fs) => {
    // Create an array of mediaNodes for all valid files in the directory
    const files: string[] = fs.readdirSync(directoryPath);
    const mediaNodes: localFileNode[] = initializeLocalNodes(`${BASE_URL}/${directoryName}`, directoryPath, files);

    if (mediaNodes.length === 0) {
        console.log('No local nodes to insert from ', directoryPath);
        return;
    }

    // Construct a single bulk insert query
    const placeholders = mediaNodes.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const query = `INSERT INTO ${tableName} (name, extension, is_video, imageURL, previewURL, source) VALUES ${placeholders}`;

    // Flatten the mediaNodes array into a single array of values
    const values = mediaNodes.flatMap(node => [
        node.name,
        node.extension,
        node.is_video,
        node.imageURL,
        node.previewURL,
        node.source,
    ]);

    try {
        console.log(`Inserting ${mediaNodes.length} local nodes from ${directoryPath} into the database.`);
        await db.run(query, values);
    } catch (err) {
        console.error('Error performing bulk insert:', err.message);
    }
};

const getLocalMedia = async (db) => {
    return (await db.all('SELECT * from Local')); 
}


export { initializeLocalDB, addLocalNodes };