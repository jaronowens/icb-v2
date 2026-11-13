import { Router } from 'express';

const router = Router();

/* GET the server's readiness, so the front end can wait for startup sync to finish. */
router.get('/', (req, res) => {
    res.json({ database: req.app.locals.dbStatus });
});

export default router;
