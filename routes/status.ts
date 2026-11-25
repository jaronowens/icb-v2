import { Router } from 'express';
import { IDLE_STATUS } from '../service/jobStatus';

const router = Router();

/* GET the server's readiness, so the front end can wait for startup sync to finish, and the progress of the background perceptual hashing and thumbnail jobs. */
router.get('/', (req, res) => {
    res.json({
        database: req.app.locals.dbStatus,
        perceptualHashing: req.app.locals.perceptualHashing?.status() ?? IDLE_STATUS,
        thumbnails: req.app.locals.thumbnailJob?.status() ?? IDLE_STATUS,
    });
});

export default router;
