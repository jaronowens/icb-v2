"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.synchronizeMedia = exports.getMedia = exports.populateMediaFromSource = exports.initializeMediaDB = void 0;
var tableName = 'Media';
var initializeMediaDB = function (db_1) {
    var args_1 = [];
    for (var _i = 1; _i < arguments.length; _i++) {
        args_1[_i - 1] = arguments[_i];
    }
    return __awaiter(void 0, __spreadArray([db_1], args_1, true), void 0, function (db, drop) {
        var err_1;
        if (drop === void 0) { drop = false; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!drop) return [3 /*break*/, 2];
                    console.log('about to try to drop table if exists, tableName: ', tableName);
                    return [4 /*yield*/, db.run("DROP TABLE IF EXISTS ".concat(tableName))];
                case 1:
                    _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    console.log('creating media table');
                    return [4 /*yield*/, db.run("CREATE TABLE ".concat(tableName, " (type TEXT, isMounted BOOL, tags TEXT, imageURL TEXT, sourceID INT, mediaCollectionID INT, userDataID INT,\n                FOREIGN KEY (mediaCollectionID) REFERENCES Collections_Media(mediaID),\n                FOREIGN KEY (userDataID) REFERENCES UserData(rowid)\n                )"))];
                case 3:
                    _a.sent();
                    return [3 /*break*/, 5];
                case 4:
                    err_1 = _a.sent();
                    console.error(err_1.message);
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
};
exports.initializeMediaDB = initializeMediaDB;
var populateMediaFromSource = function (sourceTable, db) { return __awaiter(void 0, void 0, void 0, function () {
    var rows, placeholders, query, values, err_2;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                console.log('trying to find unlinked local nodes from', sourceTable);
                return [4 /*yield*/, db.all("SELECT * FROM ".concat(sourceTable))];
            case 1:
                rows = _a.sent();
                // const rows = await db.all(`SELECT ${tableName}.rowid, * from ${sourceTable} LEFT JOIN ${tableName} ON ${sourceTable}.imageURL = ${tableName}.imageURL`);
                if (rows.length === 0) {
                    console.log("No unlinked local nodes found in ".concat(sourceTable));
                    return [2 /*return*/];
                }
                placeholders = rows.map(function () { return '(?, ?, ?, ?, ?, ?, ?)'; }).join(', ');
                query = "INSERT INTO ".concat(tableName, " (type, isMounted, tags, imageURL, sourceID, mediaCollectionID, userDataID) VALUES ").concat(placeholders);
                values = rows.flatMap(function (row) { return [
                    sourceTable,
                    true,
                    (row.tags ? row.tags : null),
                    row.imageURL,
                    row.rowid,
                    null,
                    null
                ]; });
                _a.label = 2;
            case 2:
                _a.trys.push([2, 4, , 5]);
                console.log("Creating ".concat(rows.length, " media nodes from ").concat(sourceTable));
                return [4 /*yield*/, db.run(query, values)];
            case 3:
                _a.sent();
                return [3 /*break*/, 5];
            case 4:
                err_2 = _a.sent();
                console.error('Error performing bulk insert:', err_2.message);
                return [3 /*break*/, 5];
            case 5: return [2 /*return*/];
        }
    });
}); };
exports.populateMediaFromSource = populateMediaFromSource;
var syncUnlinkedLocalNodes = function (db) { return __awaiter(void 0, void 0, void 0, function () {
    var query, err_3;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                query = "\n            UPDATE Local\n            SET mediaID = (\n                SELECT Media.rowid\n                FROM Media\n                WHERE Media.imageURL = Local.imageURL\n            )\n            WHERE Local.mediaID = -1;\n        ";
                return [4 /*yield*/, db.run(query)];
            case 1:
                _a.sent();
                console.log('Unlinked local nodes synchronized successfully.');
                return [3 /*break*/, 3];
            case 2:
                err_3 = _a.sent();
                console.error('Error synchronizing unlinked local nodes:', err_3.message);
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); };
var getMedia = function (db_1) {
    var args_1 = [];
    for (var _i = 1; _i < arguments.length; _i++) {
        args_1[_i - 1] = arguments[_i];
    }
    return __awaiter(void 0, __spreadArray([db_1], args_1, true), void 0, function (db, sourceTable) {
        var rows;
        if (sourceTable === void 0) { sourceTable = 'Local'; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, db.all("SELECT Media.rowid, * from ".concat(sourceTable, " LEFT JOIN ").concat(tableName, " ON ").concat(sourceTable, ".imageURL = ").concat(tableName, ".imageURL"))];
                case 1:
                    rows = _a.sent();
                    // const rows = await db.all(`SELECT * from Media
                    //     FULL JOIN Local
                    //         ON Media.imageURL = Local.imageURL
                    //     FULL JOIN External
                    //         ON Media.imageUrl = External.imageURL
                    //     FULl JOIN UserData
                    //         ON Media.userDataID = UserData.rowid
                    //         `);
                    return [2 /*return*/, rows];
            }
        });
    });
};
exports.getMedia = getMedia;
var synchronizeMedia = function (db_1) {
    var args_1 = [];
    for (var _i = 1; _i < arguments.length; _i++) {
        args_1[_i - 1] = arguments[_i];
    }
    return __awaiter(void 0, __spreadArray([db_1], args_1, true), void 0, function (db, reset) {
        var query, result;
        if (reset === void 0) { reset = true; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!reset) return [3 /*break*/, 2];
                    console.log('resetting all linked files');
                    return [4 /*yield*/, db.run('UPDATE Media SET isMounted = 0;')];
                case 1:
                    _a.sent();
                    _a.label = 2;
                case 2:
                    query = "\n        UPDATE Media\n        SET isMounted = 1\n        WHERE rowid IN (\n            SELECT Media.rowid\n            FROM Media\n            LEFT JOIN Local ON Media.imageURL = Local.imageURL\n            WHERE Media.isMounted = 0 AND Local.imageURL IS NOT NULL\n        );\n    ";
                    return [4 /*yield*/, db.run(query)];
                case 3:
                    result = _a.sent();
                    console.log("Media table synchronized.");
                    return [2 /*return*/];
            }
        });
    });
};
exports.synchronizeMedia = synchronizeMedia;
