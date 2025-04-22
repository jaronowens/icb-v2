interface localFileNode {
    id: number;
    name: string;
    extension: string,
    is_video: boolean,
    imageURL: string;
    previewURL: string;
    source: string;
}

export { localFileNode };