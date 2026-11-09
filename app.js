const createError = require('http-errors');
const express = require('express');
const qs = require('qs');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const indexRouter = require('./routes/index');
const localRouter = require('./routes/local');
const collectionRouter = require('./routes/collection');
const externalRouter = require('./routes/external');
const mediaRouter = require('./routes/media');
const directories = require('./directories.json');
const { migrate } = require('./repository/schema');
const { syncDirectory } = require('./service/localFileService');
const { deleteLocalNodesOutsideDirectories } = require('./repository/local');
const { populateMediaFromSource, syncUnlinkedLocalNodes, refreshMediaSources, synchronizeMedia } = require('./repository/media');

const app = express();

// set up cors and query parser
app.use(cors());
app.set('query parser'), function (str) {
  return qs.parse(str);
}

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// mount and initialize DBs
open({
  filename: './db/media.sqlite3',
  driver: sqlite3.Database
}).then(async (db) => {
  await migrate(db);
  // Each step depends on the previous one finishing, so everything is awaited in order:
  // all Local changes first, then Media rows for new hashes, linking, re-pointing sources, and mounting last.
  for (const directory of directories) {
    try {
      await syncDirectory(directory.name, directory.path, db, fs);
    }
    catch (err) {
      console.error(`Failed to sync ${directory.path}:`, err.message);
    }
  }
  // Directories that couldn't be read are still in directories.json, so their rows are kept
  await deleteLocalNodesOutsideDirectories(db, directories.map(directory => directory.path));
  await populateMediaFromSource('Local', db);
  await syncUnlinkedLocalNodes(db);
  await refreshMediaSources(db);
  await synchronizeMedia(db, true);
  console.log('Database ready');
}).catch((err) => {
  console.error('Database initialization failed:', err);
});

// set up CDN
directories.forEach(directory => {
  app.use(`/${directory.name}`, express.static(directory.path));
})

// Routes
app.use('/', indexRouter);
app.use('/local', localRouter);
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

module.exports = app;
