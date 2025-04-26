const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./db/media.sql');

/* GET local files listing. */
router.get('/', (req, res, next) => {
    db.prepare(`SELECT * from Media`)
    .all(function(err, rows) {
        res.json(rows);
    });
});

/* Questions */
/* Do we do CRUD on local nodes? Yes, right? So we can update user preference data on them? */
/* Do we want to create new local nodes while the app is running (i.e. uploads from the front-end)? */

/* Create a new local file node */
router.post('/', (req, res, next) => {
    res.send('created a new media node - return the ID of it. probably use the db initialize functions here to create the node');
});

/* Update a file node */
router.put('/:id', (req, res, next) => {
    res.send(`updated the media node: ${req.params.id}`);
});

router.delete('/:id', (req, res, next) => {
    res.send(`deleted media node`);
});

module.exports = router;
