import { Router } from 'express';
import createError from 'http-errors';
import { getMediaNodes, getMediaDetail, getUnmountedMediaNodes, addLocalFile } from '../service/mediaService';
import { parseId } from './middleware';

// Every route here sits behind requireDatabase (see app.ts), so startup sync has finished before any of them run.
// Handlers are async and let errors through: Express 5 sends a rejected promise to the error handler in app.ts.
const router = Router();

/* GET every mounted media item, one per Media row, using its representative file. */
router.get('/', async (req, res) => {
    // the app's shared connection, opened in bin/www.ts
    const db = await req.app.locals.db;
    res.json(await getMediaNodes(db));
});

/* GET every unmounted media item. Registered before /:id, which would otherwise match it. */
router.get('/unmounted', async (req, res) => {
    const db = await req.app.locals.db;
    res.json(await getUnmountedMediaNodes(db));
});

/* GET one media item, mounted or not, with every file behind it. */
router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const db = await req.app.locals.db;
    const media = await getMediaDetail(db, id);
    if (!media) {
        throw createError(404, `Media ${id} not found`);
    }
    res.json(media);
});

/* Register a file in a mounted directory: { "filepath": "<path>" }. 201 for a new image, 200 if it was already known. */
router.post('/', async (req, res) => {
    const db = await req.app.locals.db;
    const { id, created } = await addLocalFile(db, req.app.locals.directories, req.body?.filepath);
    res.status(created ? 201 : 200).json({ id });
});

/* Editing media comes with the Tags feature (PUT /media/:id), in a later spec. */
router.put(['/', '/:id'], () => {
    throw createError(501, 'Editing media is not implemented yet');
});

/* Deleting media needs a blacklist of image hashes, so files still on disk stay hidden. That's its own spec. */
router.delete(['/', '/:id'], () => {
    throw createError(501, 'Deleting media is not implemented yet');
});

export default router;
