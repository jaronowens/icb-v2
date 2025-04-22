import { localFileNode } from "../entity/localFileNode";
import { initializeLocalNodes } from "../service/localFileService";
const BASE_URL :string = 'http://localhost:3000';

const initializeMediaDB = (db) => {

    db.serialize(() => {
        db.run("CREATE TABLE media (info TEXT)");

        const stmt = db.prepare("INSERT INTO media VALUES (?)");
        for (let i = 0; i < 10; i++) {
            stmt.run("Ipsum " + i);
        }
        stmt.finalize();

        db.each("SELECT rowid AS id, info FROM media", (err, row) => {
            console.log(row.id + ": " + row.info);
        });
    });
}

const createTableFromDirectory = (tableName: string, dirPath: string, files: string[], db) => {
    // create an array of mediaNodes for all valid files in the dirPath
    console.log(`tableName = ${tableName}, dirPath: ${dirPath}`);
    const mediaNodes: localFileNode[] = initializeLocalNodes(`${BASE_URL}/${tableName}`, files);
    // console.log(mediaNodes);
    db.serialize(() => {
        console.log('about to try to drop table if exists, tableName: ', tableName);
        db.run(`DROP TABLE IF EXISTS ${tableName}`);
        console.log('creating table');
        db.run(`CREATE TABLE ${tableName} (id INT, name TEXT, extension TEXT, is_video BOOL, imageURL TEXT, previewURL TEXT, source TEXT)`);
        mediaNodes.forEach(node => {
            console.log(`creating node for ${node.name}`);
            const stmt = db.prepare(`INSERT INTO ${tableName} (id, name, extension, is_video, imageURL, previewURL, source) VALUES(?, ?, ?, ?, ?, ?, ?)`)
            .bind(node.id, node.name, node.extension, node.is_video, node.imageURL, node.previewURL, node.source)
            .run();
            stmt.finalize();
        });
    });
    // check if the table already exists
    // if so, drop the table and recreate it
    // otherwise, create a new table
    // then add all mediaNodes to the database

    // return whether or not the operation was successful
}


export { initializeMediaDB, createTableFromDirectory };