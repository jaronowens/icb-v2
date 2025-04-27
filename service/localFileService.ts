import { localFileNode } from "../entity/localFileNode";

const supportedFileTypes: string[] = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm'];
const specialCharacters: string[] = ['(', ')', '-', ' '];

const getFileExtension = (url: string) => {
    const splitUrl = url.split('.');
    const extension = splitUrl.pop();
    if (extension) {
        return extension.split(/\#|\?/)[0];
    }
    return "";
}

const isValidFile = (file: string) => {
    return supportedFileTypes.includes(getFileExtension(file));
}

const initializeLocalNode = (fileDir: string, directoryPath: string, fileUrl: string) => {
    const nodeExtension: string = getFileExtension(fileUrl);
    const newMediaNode: localFileNode = {
        name: fileUrl,
        width: 0,
        height: 0,
        extension: nodeExtension,
        is_video: (nodeExtension === 'mp4' || nodeExtension === 'webm') ? true : false,
        imageURL: `${fileDir}/${fileUrl}`,
        previewURL: `${fileDir}/${fileUrl}`,
        source: `${directoryPath}/${fileUrl}`
    }
    return newMediaNode;
}

const initializeLocalNodes = (fileDir: string, directoryPath: string, files: string[]) => {
    const initializedNodes: localFileNode[] = [];
    files.forEach(file => {
        if (isValidFile(file)) {
            initializedNodes.push(initializeLocalNode(fileDir, directoryPath, file));
        } else {
            console.log(`Unsupported filetype, skipping ${file}.`);
        }
    });
    return initializedNodes;
}

export { initializeLocalNodes };