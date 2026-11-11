interface MediaNode {
    id: number;
    name: string;
    width: number | null; // NULL when the file can't be measured (videos, unreadable images)
    height: number | null;
    extension: string,
    is_video: boolean;
    source: string;
    tags: string;
    imageURL: string;
    imageHash: string;
    previewURL: string;
}

export {MediaNode};