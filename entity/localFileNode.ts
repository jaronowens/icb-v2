interface localFileNode {
    id?: number; // set on rows read back from the database
    name: string;
    extension: string,
    width: number,
    height: number,
    is_video: boolean,
    imageURL: string;
    imageHash: string;
    previewURL: string;
    source: string;
    directoryPath: string;
    size: number;
    mtimeMs: number;
}

export { localFileNode };
