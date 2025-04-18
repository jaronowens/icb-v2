const express = require('express');
const router = express.Router();

/* GET a list of all collections */
router.get('/', (req, res, next) => {
  res.send('collections - respond with a list of all collections');
});

/* GET a specific collection by its ID */
router.get('/:id', (req, res, next) => {
  res.send(`respond with the specific collection requested: ${req.params.id}`,);
});

/* Create a new collection with the incoming data */
router.post('/', (req, res, next) => {
  res.send(`created a new collection, return the ID of it (probably)`);
});

router.put('/:id', (req, res, next) => {
  res.send(`updated collection ${req.params.id}`);
});
router.delete('/:id', (req, res, next) => {
  res.send(`deleted collection`);
});

module.exports = router;
