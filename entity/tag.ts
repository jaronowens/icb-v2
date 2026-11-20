/* GET /tags/:tagName: a tag and how many Media rows (mounted or not) it's linked to. */
interface TagDetail {
    name: string;
    count: number;
}

/* POST and PUT /tags/:tagName: the tag's name and where to GET it. */
interface TagRef {
    name: string;
    url: string;
}

export { TagDetail, TagRef };
