const express = require('express');
const router = express.Router();

/* GET from an external API */
router.get('/gelbooru', (req, res, next) => {
    // build a gelbooru query
    // send a request to danbooru's API
    // interpret the results into the mediaNode type
    res.send('respond with the list of mediaNodes');
});

router.get('/*', (req, res, next) => {

    res.send('error: unsupported external site');
});

module.exports = router;
