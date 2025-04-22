"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addLocalMediaToTable = exports.initializeLocalDB = void 0;
var localFileService_1 = require("../service/localFileService");
var BASE_URL = 'http://localhost:3000';
var tableName = 'Local';
var initializeLocalDB = function (db, drop) {
    if (drop === void 0) { drop = true; }
    db.serialize(function () {
        if (drop) {
            console.log('about to try to drop table if exists, tableName: ', tableName);
            db.run("DROP TABLE IF EXISTS ".concat(tableName));
        }
        console.log('creating table');
        db.run("CREATE TABLE ".concat(tableName, " (name TEXT, extension TEXT, is_video BOOL, imageURL TEXT, previewURL TEXT, source TEXT)"));
    });
};
exports.initializeLocalDB = initializeLocalDB;
var addLocalMediaToTable = function (directoryName, files, db) {
    // create an array of mediaNodes for all valid files in the dirPath
    var mediaNodes = (0, localFileService_1.initializeLocalNodes)("".concat(BASE_URL, "/").concat(directoryName), files);
    // console.log(mediaNodes);
    mediaNodes.forEach(function (node) {
        console.log("creating node for ".concat(node.name));
        var stmt = db.prepare("INSERT INTO ".concat(tableName, " (name, extension, is_video, imageURL, previewURL, source) VALUES(?, ?, ?, ?, ?, ?)"))
            .bind(node.name, node.extension, node.is_video, node.imageURL, node.previewURL, node.source)
            .run();
        stmt.finalize();
    });
};
exports.addLocalMediaToTable = addLocalMediaToTable;
