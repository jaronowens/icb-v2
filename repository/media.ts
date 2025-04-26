import { localFileNode } from "../entity/localFileNode";
import { initializeLocalNodes } from "../service/localFileService";
const BASE_URL: string = 'http://localhost:3000';
const tableName: string = 'Media';

const initializeMediaDB = (db, drop: boolean = false) => {
    db.serialize(() => {
        if (drop) {
            console.log('about to try to drop table if exists, tableName: ', tableName);
            db.run(`DROP TABLE IF EXISTS ${tableName}`);
        }
        try {
            console.log('creating table');
            db.run(`CREATE TABLE ${tableName} (type TEXT, isMounted BOOL, tags TEXT, imageURL TEXT, mediaID INT, userDataID INT,
                FOREIGN KEY (mediaID) REFERENCES Collections_Media(mediaID),
                FOREIGN KEY (userDataID) REFERENCES UserData(rowid)
                )`);
        } catch (err) {
            console.error(err.message);
        }
    });
}

const populateMediaFromSource = (sourceTable: string, db) => {
        console.log('trying to find imageURLs from', sourceTable, 'that do not have a match');
        db.all(`SELECT * FROM ${sourceTable}`, (err, rows) => {
            rows.forEach(row => {
                console.log(row);
                db.prepare(`INSERT INTO ${tableName} (type, isMounted, tags, imageURL, mediaID, userDataID) VALUES(?, ?, ?, ?, ?, ?)`)
                .bind(sourceTable, true, (row.tags ? row.tags : null), row.imageURL, null, null)
                .run();
            })
        });
}

const addMediaToTable = (directoryName: string, directoryPath: string, db, fs) => {
    // create an array of mediaNodes for all valid files in the dirPath
    const files: string[] = fs.readdirSync(directoryPath);
    const mediaNodes: localFileNode[] = initializeLocalNodes(`${BASE_URL}/${directoryName}`, directoryPath, files);
    // console.log(mediaNodes);
    mediaNodes.forEach(node => {
        console.log(`creating node for ${node.name}`);
        const stmt = db.prepare(`INSERT INTO ${tableName} (name, extension, is_video, imageURL, previewURL, source) VALUES(?, ?, ?, ?, ?, ?)`)
            .bind(node.name, node.extension, node.is_video, node.imageURL, node.previewURL, node.source)
            .run();
        stmt.finalize();
    });
}


export { initializeMediaDB, populateMediaFromSource };