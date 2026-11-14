import createError, { HttpError } from 'http-errors';
import express, { Request, Response, NextFunction } from 'express';
import * as path from 'node:path';
import cookieParser from 'cookie-parser';
import logger from 'morgan';
import cors from 'cors';
import { Database } from 'sqlite';

import indexRouter from './routes/index';
import collectionRouter from './routes/collection';
import externalRouter from './routes/external';
import mediaRouter from './routes/media';
import statusRouter from './routes/status';
import { requireDatabase } from './routes/middleware';
import { isValidDirectoryName, Directory } from './service/startupService';
import { PerceptualHashJob } from './service/perceptualHashService';

type DbStatus = 'starting' | 'ready' | 'failed';

type AppOptions = {
  db: Database | Promise<Database>,
  directories: Directory[],
  ready: Promise<unknown>,
  perceptualHashing?: PerceptualHashJob,
};

/**
 * Builds the Express app. Has no side effects: the caller opens the database and runs startup sync
 * (see bin/www.ts and service/startupService.ts).
 *
 * - `db`: an open sqlite connection, or the promise for one. Routes get it with `await req.app.locals.db`,
 *   so a request that arrives before the connection is open waits for it, and gets a 500 if opening failed.
 * - `directories`: the `{ name, path }` entries to serve files from, as in directories.json.
 * - `ready`: settles when startup sync finishes: resolves once the database is ready, rejects if startup fails.
 *   Until then `/media` answers 503 (see routes/middleware.ts), and `GET /status` reports the state.
 * - `perceptualHashing`: the background perceptual hash job (service/perceptualHashService.ts), if there is one.
 *   `GET /status` reports its progress and `POST /media` triggers it for new images. The caller starts it.
 */
function createApp({ db, directories, ready, perceptualHashing }: AppOptions) {
  const validDirectories = directories.filter(directory => {
    if (!isValidDirectoryName(directory.name)) {
      console.error(`Skipping directory "${directory.name}" (${directory.path}): names may only contain letters, digits, - and _`);
      return false;
    }
    return true;
  });

  const app = express();

  // set up cors and query parser
  app.use(cors());
  // Express 5 defaults to the 'simple' parser; 'extended' keeps nested queries like ?a[b]=1
  app.set('query parser', 'extended');

  // view engine setup
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'pug');

  // request logging is noise in test output
  if (process.env.NODE_ENV !== 'test') {
    app.use(logger('dev'));
  }
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));

  app.locals.db = db;
  app.locals.directories = validDirectories;
  app.locals.dbStatus = 'starting' as DbStatus;
  app.locals.dbError = null;
  app.locals.perceptualHashing = perceptualHashing;
  // The rejection handler also marks the promise as handled, so a failed startup is never an unhandled rejection
  ready.then(
    () => { app.locals.dbStatus = 'ready'; },
    err => {
      app.locals.dbStatus = 'failed';
      app.locals.dbError = err;
    },
  );

  // set up CDN
  validDirectories.forEach(directory => {
    app.use(`/${directory.name}`, express.static(directory.path));
  });

  // Routes
  app.use('/', indexRouter);
  app.use('/collection', collectionRouter);
  app.use('/external', externalRouter);
  app.use('/media', requireDatabase, mediaRouter);
  app.use('/status', statusRouter);

  // catch 404 and forward to error handler
  app.use((req: Request, res: Response, next: NextFunction) => {
    next(createError(404, `Not found: ${req.method} ${req.path}`));
  });

  // error handler: the pug error page for the home page, JSON for everything else.
  // Express only treats a handler with four parameters as an error handler.
  app.use((err: HttpError, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      // too late to send an error response; Express closes the connection
      return next(err);
    }
    const status = err.status || err.statusCode || 500;
    const isDevelopment = req.app.get('env') === 'development';
    // unexpected failures only: deliberate errors like the 503 while starting would flood the log
    if (status === 500) {
      console.error(`${req.method} ${req.originalUrl} failed:`, err);
    }
    res.status(status);

    if (req.path === '/') {
      // only provide the error in development
      res.locals.message = err.message;
      res.locals.error = isDevelopment ? err : {};
      return res.render('error');
    }
    res.json({ error: err.message, ...(isDevelopment ? { stack: err.stack } : {}) });
  });

  return app;
}

export { createApp, DbStatus };
