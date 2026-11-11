const createError = require('http-errors');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const cors = require('cors');

const indexRouter = require('./routes/index');
const collectionRouter = require('./routes/collection');
const externalRouter = require('./routes/external');
const mediaRouter = require('./routes/media');
const { isValidDirectoryName } = require('./service/startupService');

/**
 * Builds the Express app. Has no side effects: the caller opens the database and runs startup sync
 * (see bin/www and service/startupService.ts).
 *
 * - `db`: an open sqlite connection, or the promise for one. Routes get it with `await req.app.locals.db`,
 *   so a request that arrives before the connection is open waits for it, and gets a 500 if opening failed.
 * - `directories`: the `{ name, path }` entries to serve files from, as in directories.json.
 */
function createApp({ db, directories }) {
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

  // set up CDN
  validDirectories.forEach(directory => {
    app.use(`/${directory.name}`, express.static(directory.path));
  })

  // Routes
  app.use('/', indexRouter);
  app.use('/collection', collectionRouter);
  app.use('/external', externalRouter);
  app.use('/media', mediaRouter);

  // catch 404 and forward to error handler
  app.use(function (req, res, next) {
    next(createError(404));
  });

  // error handler
  app.use(function (err, req, res, next) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};

    // render the error page
    res.status(err.status || 500);
    res.render('error');
  });

  return app;
}

module.exports = { createApp };
