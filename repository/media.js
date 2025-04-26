"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.populateMediaFromSource = exports.initializeMediaDB = void 0;
var localFileService_1 = require("../service/localFileService");
var BASE_URL = 'http://localhost:3000';
var tableName = 'Media';
var initializeMediaDB = function (db, drop) {
    if (drop === void 0) { drop = false; }
    db.serialize(function () {
        if (drop) {
            console.log('about to try to drop table if exists, tableName: ', tableName);
            db.run("DROP TABLE IF EXISTS ".concat(tableName));
        }
        try {
            console.log('creating table');
            db.run("CREATE TABLE ".concat(tableName, " (type TEXT, isMounted BOOL, tags TEXT, imageURL TEXT, mediaID INT, userDataID INT,\n                FOREIGN KEY (mediaID) REFERENCES Collections_Media(mediaID),\n                FOREIGN KEY (userDataID) REFERENCES UserData(rowid)\n                )"));
        }
        catch (err) {
            console.error(err.message);
        }
    });
};
exports.initializeMediaDB = initializeMediaDB;
var populateMediaFromSource = function (sourceTable, db) {
    console.log('trying to find imageURLs from', sourceTable, 'that do not have a match');
    db.all("SELECT * FROM ".concat(sourceTable), function (err, rows) {
        rows.forEach(function (row) {
            console.log(row);
            db.prepare("INSERT INTO ".concat(tableName, " (type, isMounted, tags, imageURL, mediaID, userDataID) VALUES(?, ?, ?, ?, ?, ?)"))
                .bind(sourceTable, true, (row.tags ? row.tags : null), row.imageURL, null, null)
                .run();
        });
    });
};
exports.populateMediaFromSource = populateMediaFromSource;
var addMediaToTable = function (directoryName, directoryPath, db, fs) {
    // create an array of mediaNodes for all valid files in the dirPath
    var files = fs.readdirSync(directoryPath);
    var mediaNodes = (0, localFileService_1.initializeLocalNodes)("".concat(BASE_URL, "/").concat(directoryName), directoryPath, files);
    // console.log(mediaNodes);
    mediaNodes.forEach(function (node) {
        console.log("creating node for ".concat(node.name));
        var stmt = db.prepare("INSERT INTO ".concat(tableName, " (name, extension, is_video, imageURL, previewURL, source) VALUES(?, ?, ?, ?, ?, ?)"))
            .bind(node.name, node.extension, node.is_video, node.imageURL, node.previewURL, node.source)
            .run();
        stmt.finalize();
    });
};
