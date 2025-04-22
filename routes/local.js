const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./db/media.sql');

/* GET local files listing. */
router.get('/', (req, res, next) => {
    db.prepare(`SELECT * from Local`)
    .all(function(err, rows) {
        res.json(rows);
    });
});

router.get('/:name', (req, res, next) => {
    // search by file path to pull this off?
    db.prepare(`SELECT * from Local WHERE name = ?`, req.params.name)
    .all(function(err, rows) {
        res.json(rows);
    });
});

/* Do we want to create new local nodes while the app is running (i.e. uploads from the front-end)? */

module.exports = router;
