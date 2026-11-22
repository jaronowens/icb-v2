/* One tag in a GET /media?tags= query: a normalized name, and whether the media must NOT have it. */
interface TagTerm {
    name: string;
    negated: boolean;
}

/* Outer array = AND, inner array = OR (a bare string in the query becomes a group of one). */
type TagQuery = TagTerm[][];

/* The parsed GET /media query parameters. A field that's left out doesn't filter. */
interface MediaSearch {
    name?: string;
    extensions?: string[]; // the extension plus its aliases, e.g. ['jpg', 'jpeg']
    isVideo?: boolean;
    hash?: string; // normalized to 'sha256:<lowercase hex>'
    tags?: TagQuery; // left out when the array is []
    count?: number; // a positive integer; left out means no limit
}

export { TagTerm, TagQuery, MediaSearch };
