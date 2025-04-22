import { MediaNode } from "../entity/mediaNode";
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

const initializeLocalNode = (fileDir: string, fileUrl: string, nodeId: number) => {
    const nodeExtension: string = getFileExtension(fileUrl);
    const newMediaNode: localFileNode = {
        name: fileUrl,
        extension: nodeExtension,
        is_video: (nodeExtension === 'mp4' || nodeExtension === 'webm') ? true : false,
        imageURL: `${fileDir}/${fileUrl}`,
        previewURL: `${fileDir}/${fileUrl}`,
        source: fileDir
    }
    return newMediaNode;
}

const initializeLocalNodes = (fileDir: string, files: string[]) => {
    const initializedNodes: localFileNode[] = [];
    let index: number = 0;
    files.forEach(file => {
        if (isValidFile(file)) {
            initializedNodes.push(initializeLocalNode(fileDir, file, index));
        } else {
            console.log(`Unsupported filetype, skipping ${file}.`);
        }
        index++;
    });
    return initializedNodes;
}

const convertLocalNode = (localNode: localFileNode) => {
    const newMediaNode: MediaNode = {
        name: localNode.name,
        width: 0,
        height: 0,
        extension: localNode.extension,
        is_video: localNode.is_video,
        source: localNode.source,
        tags: "",
        imageURL: localNode.imageURL,
        previewURL: localNode.imageURL
    }
    return newMediaNode;
}

const convertLocalNodes = (localNodes: localFileNode[]) => {
    const convertedNodes: MediaNode[] = [];
    localNodes.forEach(node => {
        convertedNodes.push(convertLocalNode(node));
    });
    return convertedNodes;
}

export { initializeLocalNodes, convertLocalNodes };