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
var convertLocalNode = function (localNode) {
    var newMediaNode = {
        name: localNode.name,
        width: 0,
        height: 0,
        extension: localNode.extension,
        is_video: localNode.is_video,
        source: localNode.source,
        tags: "",
        imageURL: localNode.imageURL,
        previewURL: localNode.imageURL
    };
    return newMediaNode;
};
var convertLocalNodes = function (localNodes) {
    var convertedNodes = [];
    localNodes.forEach(function (node) {
        convertedNodes.push(convertLocalNode(node));
    });
    return convertedNodes;
};
