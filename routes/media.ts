import { Router } from 'express';
import { getMediaNodes } from '../service/mediaService';

const router = Router();

/* GET local files listing. */
// Express 5 passes a rejected promise from an async handler to the error handler (a 500), instead of crashing
router.get('/', async (req, res) => {
    // the app's shared connection, opened in bin/www.ts
    const db = await req.app.locals.db;
    res.json(await getMediaNodes(db));
});

/* Questions */
/* Do we do CRUD on local nodes? Yes, right? So we can update user preference data on them? */
/* Do we want to create new local nodes while the app is running (i.e. uploads from the front-end)? */

/* Create a new local file node */
router.post('/', (req, res) => {
    res.send('created a new media node - return the ID of it');
});

/* Update a file node */
router.put('/:id', (req, res) => {
    res.send(`updated the media node: ${req.params.id}`);
});

router.delete('/:id', (req, res) => {
    res.send(`deleted media node`);
});

export default router;
