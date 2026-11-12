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
const app = createApp({ db: dbConnection, directories: directories });

/**
 * Sync the database with directories.json. Not awaited, so the server listens while sync runs.
 */

startup(dbConnection, directories).catch(err => {
  console.error('Database initialization failed:', err);
});

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
