interface MediaNode {
    id: number;
    name: string;
    width: number;
    height: number;
    file_ext: string,
    is_video: boolean;
    source: string;
    tags: string;
    imageURL: string;
    previewURL: string;
}

export {MediaNode};