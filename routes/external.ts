import { Router } from 'express';

const router = Router();

/* GET from an external API */
router.get('/gelbooru', (req, res) => {
    // build a gelbooru query
    // send a request to danbooru's API
    // interpret the results into the mediaNode type
    res.send('respond with the list of mediaNodes');
});

// Express 5 wildcards must be named; the braces make it optional so /external/ also matches
router.get('/{*splat}', (req, res) => {
    res.send('error: unsupported external site');
});

export default router;
