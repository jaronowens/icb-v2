#!/usr/bin/env node

/**
 * Module dependencies.
 */

import * as http from 'node:http';
import createDebug from 'debug';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { createApp } from '../app';
import { startup } from '../service/startupService';
import { createPerceptualHashJob, workerCountFromEnv } from '../service/perceptualHashService';
import { createThumbnailService } from '../service/thumbnailService';
import { createThumbnailJob } from '../service/thumbnailJob';
import directories from '../directories.json';

const debug = createDebug('icb-v2:server');

/**
 * Open the database and build the app. One connection for the whole app, stored as a promise
 * (see createApp in app.ts).
 */

const dbConnection = open({
  filename: './db/media.sqlite3',
  driver: sqlite3.verbose().Database
});

/**
 * Sync the database with directories.json. Not awaited, so the server listens while sync runs;
 * the app answers 503 on /media until it finishes (see createApp in app.ts).
 */

const ready = startup(dbConnection, directories);
ready.catch(err => {
  console.error('Database initialization failed:', err);
});

/**
 * Fill in perceptual hashes in the background once the database is ready (see service/perceptualHashService.ts).
 * POST /media triggers it again for new images.
 *
 * Then make thumbnails (see service/thumbnailJob.ts). The thumbnail job starts whenever the perceptual hash job goes
 * idle, so the two never compete for CPU and the threadpool, and one trigger covers both: a new image's thumbnail
 * follows its perceptual hash. Until the job reaches an image, /thumbnails makes its thumbnail on request. The cache
 * folder (THUMBNAIL_DIR) isn't created until the first thumbnail is written.
 */

const thumbnails = createThumbnailService({ dir: process.env.THUMBNAIL_DIR || './db/thumbnails' });
const thumbnailJob = createThumbnailJob(dbConnection, thumbnails);
const perceptualHashing = createPerceptualHashJob(dbConnection, {
  workers: workerCountFromEnv(),
  onIdle: () => thumbnailJob.trigger(),
});
ready.then(() => perceptualHashing.trigger(), () => {});
const app = createApp({ db: dbConnection, directories: directories, ready, perceptualHashing, thumbnails, thumbnailJob });

/**
 * Get port from environment and store in Express.
 */

const port = normalizePort(process.env.PORT || '3000');
app.set('port', port);

/**
 * Create HTTP server.
 */

const server = http.createServer(app);

/**
 * Listen on provided port, on all network interfaces.
 */

server.listen(port);
server.on('error', onError);
server.on('listening', onListening);

/**
 * Normalize a port into a number, string, or false.
 */

function normalizePort(val: string): number | string | false {
  const port = parseInt(val, 10);

  if (isNaN(port)) {
    // named pipe
    return val;
  }

  if (port >= 0) {
    // port number
    return port;
  }

  return false;
}

/**
 * Event listener for HTTP server "error" event.
 */

function onError(error: NodeJS.ErrnoException) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const bind = typeof port === 'string'
    ? 'Pipe ' + port
    : 'Port ' + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */

function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string'
    ? 'pipe ' + addr
    : 'port ' + addr.port;
  debug('Listening on ' + bind);
}
