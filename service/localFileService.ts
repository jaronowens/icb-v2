import { localFileNode } from "../entity/localFileNode";
import { createLocalTable, insertLocalNodes } from "../repository/local";
const BASE_URL: string = 'http://localhost:3000';

const supportedFileTypes: string[] = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm'];
const specialCharacters: string[] = ['(', ')', '-', ' '];

/* Helpers */
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

/* Constructors */
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

const initializeLocalDB = async (db, drop: boolean = true) => {
    try {
        await createLocalTable(db, drop);
    } catch (err) {
        console.error(`Error accessing database: ${err.message}`);
    }
}

const createLocalNodes = async (directoryName: string, directoryPath: string, db, fs) => {
    // Create an array of mediaNodes for all valid files in the directory
    const files: string[] = fs.readdirSync(directoryPath);
    const localNodes: localFileNode[] = initializeLocalNodes(`${BASE_URL}/${directoryName}`, directoryPath, files);

    if (localNodes.length === 0) {
        console.log('No local nodes to insert from ', directoryPath);
        return;
    }
    try {
        await insertLocalNodes(directoryPath, localNodes, db);
    } catch (err) {
        console.error(`Error accessing database: ${err.message}`);
    }
}

export { initializeLocalDB, createLocalNodes };