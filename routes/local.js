const express = require('express');
const router = express.Router();

/* GET local files listing. */
router.get('/', (req, res, next) => {
    res.send('respond with a list of all files in the database (with optional query parameter filtering)');
});

router.get('/:id', (req, res, next) => {
    // search by file path to pull this off?
    res.send(`respond with file ${req.params.id}`);
});

/* Do we want to create new local nodes while the app is running (i.e. uploads from the front-end)? */

module.exports = router;
