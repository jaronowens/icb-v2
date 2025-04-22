"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTableFromDirectory = exports.initializeMediaDB = void 0;
var localFileService_1 = require("../service/localFileService");
var BASE_URL = 'http://localhost:3000';
var initializeMediaDB = function (db) {
    db.serialize(function () {
        db.run("CREATE TABLE media (info TEXT)");
        var stmt = db.prepare("INSERT INTO media VALUES (?)");
        for (var i = 0; i < 10; i++) {
            stmt.run("Ipsum " + i);
        }
        stmt.finalize();
        db.each("SELECT rowid AS id, info FROM media", function (err, row) {
            console.log(row.id + ": " + row.info);
        });
    });
};
exports.initializeMediaDB = initializeMediaDB;
var createTableFromDirectory = function (tableName, dirPath, files, db) {
    // create an array of mediaNodes for all valid files in the dirPath
    console.log("tableName = ".concat(tableName, ", dirPath: ").concat(dirPath));
    var mediaNodes = (0, localFileService_1.initializeLocalNodes)("".concat(BASE_URL, "/").concat(tableName), files);
    // console.log(mediaNodes);
    db.serialize(function () {
        console.log('about to try to drop table if exists, tableName: ', tableName);
        db.run("DROP TABLE IF EXISTS ".concat(tableName));
        console.log('creating table');
        db.run("CREATE TABLE ".concat(tableName, " (id INT, name TEXT, extension TEXT, is_video BOOL, imageURL TEXT, previewURL TEXT, source TEXT)"));
        mediaNodes.forEach(function (node) {
            console.log("creating node for ".concat(node.name));
            var stmt = db.prepare("INSERT INTO ".concat(tableName, " (id, name, extension, is_video, imageURL, previewURL, source) VALUES(?, ?, ?, ?, ?, ?, ?)"))
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
};
exports.createTableFromDirectory = createTableFromDirectory;
