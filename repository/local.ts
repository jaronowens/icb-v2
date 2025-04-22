import { localFileNode } from "../entity/localFileNode";
import { initializeLocalNodes } from "../service/localFileService";
const BASE_URL :string = 'http://localhost:3000';
const tableName :string = 'Local';

const initializeLocalDB = (db, drop: boolean = true) => {
    db.serialize(() => {
        if(drop) {
            console.log('about to try to drop table if exists, tableName: ', tableName);
            db.run(`DROP TABLE IF EXISTS ${tableName}`);
        }
        console.log('creating table');
        db.run(`CREATE TABLE ${tableName} (name TEXT, extension TEXT, is_video BOOL, imageURL TEXT UNIQUE, previewURL TEXT, source TEXT)`);
    });
    // FOREIGN KEY (mediaID) REFERENCES Media(rowid)
}

const addLocalMediaToTable = (directoryName: string, files: string[], db) => {
    // create an array of mediaNodes for all valid files in the dirPath
    const mediaNodes: localFileNode[] = initializeLocalNodes(`${BASE_URL}/${directoryName}`, files);
    // console.log(mediaNodes);
    mediaNodes.forEach(node => {
        console.log(`creating node for ${node.name}`);
        const stmt = db.prepare(`INSERT INTO ${tableName} (name, extension, is_video, imageURL, previewURL, source) VALUES(?, ?, ?, ?, ?, ?)`)
        .bind(node.name, node.extension, node.is_video, node.imageURL, node.previewURL, node.source)
        .run();
        stmt.finalize();
    });
}


export { initializeLocalDB, addLocalMediaToTable };