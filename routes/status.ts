import { Router } from 'express';
import { IDLE_STATUS } from '../service/perceptualHashService';

const router = Router();

/* GET the server's readiness, so the front end can wait for startup sync to finish, and background perceptual hashing progress. */
router.get('/', (req, res) => {
    res.json({
        database: req.app.locals.dbStatus,
        perceptualHashing: req.app.locals.perceptualHashing?.status() ?? IDLE_STATUS,
    });
});

export default router;
