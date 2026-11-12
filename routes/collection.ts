import { Router } from 'express';

const router = Router();

/* GET a list of all collections */
router.get('/', (req, res) => {
  res.send('collections - respond with a list of all collections');
});

/* GET a specific collection by its ID */
router.get('/:id', (req, res) => {
  res.send(`respond with the specific collection requested: ${req.params.id}`);
});

/* Create a new collection with the incoming data */
router.post('/', (req, res) => {
  res.send(`created a new collection, return the ID of it (probably)`);
});

router.put('/:id', (req, res) => {
  res.send(`updated collection ${req.params.id}`);
});
router.delete('/:id', (req, res) => {
  res.send(`deleted collection`);
});

export default router;
