import { Router } from 'express';
import { listTags, getTagDetail, createTag, renameOrMergeTag, removeTag } from '../service/tagService';

// Behind requireDatabase (see app.ts), like /media. Tag names in the path are percent-encoded by the client
// (Express decodes them) and normalized by the service, so /tags/Elf and /tags/elf are the same tag.
const router = Router();

/* GET every tag name, sorted. */
router.get('/', async (req, res) => {
    const db = await req.app.locals.db;
    res.json(await listTags(db));
});

/* GET one tag with the number of media linked to it: { name, count }. */
router.get('/:tagName', async (req, res) => {
    const db = await req.app.locals.db;
    res.json(await getTagDetail(db, req.params.tagName));
});

/* Add a tag: 201 { name, url } if it's new, 200 with the existing tag's { name, url } if it isn't. */
router.post('/:tagName', async (req, res) => {
    const db = await req.app.locals.db;
    const { tag, created } = await createTag(db, req.params.tagName);
    res.location(tag.url).status(created ? 201 : 200).json(tag);
});

/* Rename a tag: { "name": "<new name>" }. Renaming onto an existing tag merges the two. Answers { name, url }. */
router.put('/:tagName', async (req, res) => {
    const db = await req.app.locals.db;
    res.json(await renameOrMergeTag(db, req.params.tagName, req.body?.name));
});

/* Delete a tag and unlink every media item from it. */
router.delete('/:tagName', async (req, res) => {
    const db = await req.app.locals.db;
    await removeTag(db, req.params.tagName);
    res.sendStatus(204);
});

export default router;
