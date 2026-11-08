interface MediaNode {
    id: number;
    name: string;
    width: number;
    height: number;
    extension: string,
    is_video: boolean;
    source: string;
    tags: string;
    imageURL: string;
    imageHash: string;
    previewURL: string;
}

export {MediaNode};