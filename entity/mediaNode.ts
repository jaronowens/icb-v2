/* An entry in GET /media. For unmounted media, every field that comes from its Local file is null. */
interface MediaNode {
    id: number;
    name: string;
    width: number | null; // NULL when the file can't be measured (videos, unreadable images)
    height: number | null;
    extension: string,
    is_video: boolean;
    source: string;
    tags: string[]; // sorted by name, [] if it has none
    imageURL: string;
    imageHash: string;
    previewURL: string; // a thumbnail for jpg/jpeg/png/webp, otherwise the same as imageURL. null for unmounted media
}

/* One Local file behind a Media row. */
interface MediaFile {
    id: number;
    name: string;
    extension: string;
    is_video: boolean;
    imageURL: string;
    previewURL: string; // a thumbnail for jpg/jpeg/png/webp, otherwise the same as imageURL
    source: string;
}

/* GET /media/:id: the entry plus every file behind it, representative first. Unmounted media have no files. */
interface MediaDetail extends MediaNode {
    isMounted: boolean;
    files: MediaFile[];
}

export { MediaNode, MediaFile, MediaDetail };
