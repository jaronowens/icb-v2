interface localFileNode {
    name: string;
    extension: string,
    width: number,
    height: number,
    is_video: boolean,
    imageURL: string;
    imageHash: string;
    previewURL: string;
    source: string;
}

export { localFileNode };