"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeLocalNodes = void 0;
var supportedFileTypes = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm'];
var specialCharacters = ['(', ')', '-', ' '];
var getFileExtension = function (url) {
    var splitUrl = url.split('.');
    var extension = splitUrl.pop();
    if (extension) {
        return extension.split(/\#|\?/)[0];
    }
    return "";
};
var isValidFile = function (file) {
    return supportedFileTypes.includes(getFileExtension(file));
};
var initializeLocalNode = function (fileDir, directoryPath, fileUrl) {
    var nodeExtension = getFileExtension(fileUrl);
    var newMediaNode = {
        name: fileUrl,
        width: 0,
        height: 0,
        extension: nodeExtension,
        is_video: (nodeExtension === 'mp4' || nodeExtension === 'webm') ? true : false,
        imageURL: "".concat(fileDir, "/").concat(fileUrl),
        previewURL: "".concat(fileDir, "/").concat(fileUrl),
        source: "".concat(directoryPath, "/").concat(fileUrl)
    };
    return newMediaNode;
};
var initializeLocalNodes = function (fileDir, directoryPath, files) {
    var initializedNodes = [];
    files.forEach(function (file) {
        if (isValidFile(file)) {
            initializedNodes.push(initializeLocalNode(fileDir, directoryPath, file));
        }
        else {
            console.log("Unsupported filetype, skipping ".concat(file, "."));
        }
    });
    return initializedNodes;
};
exports.initializeLocalNodes = initializeLocalNodes;
