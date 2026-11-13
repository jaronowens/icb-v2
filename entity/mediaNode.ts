/* An entry in GET /media. For unmounted media, every field that comes from its Local file is null. */
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

/* One Local file behind a Media row. */
interface MediaFile {
    id: number;
    name: string;
    extension: string;
    is_video: boolean;
    imageURL: string;
    previewURL: string;
    source: string;
}

/* GET /media/:id: the entry plus every file behind it, representative first. Unmounted media have no files. */
interface MediaDetail extends MediaNode {
    isMounted: boolean;
    files: MediaFile[];
}

export { MediaNode, MediaFile, MediaDetail };
