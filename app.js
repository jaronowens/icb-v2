const createError = require('http-errors');
const express = require('express');
const qs = require('qs');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const indexRouter = require('./routes/index');
const localRouter = require('./routes/local');
const collectionRouter = require('./routes/collection');
const externalRouter = require('./routes/external');
const directories = require('./directories.json');
const { initializeLocalDB, addLocalMediaToTable } = require('./repository/local');

const app = express();

// mount DB
const db = new sqlite3.Database('./db/media.sql');

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

// initialize DBs
initializeLocalDB(db, true);

directories.forEach(directory => {
  try {
    app.use(`/${directory.name}`, express.static(directory.path));
    addLocalMediaToTable(directory.name, directory.path, db, fs);
  }
  catch (err) {
    console.error(err.message);
  }
});

db.close();

// Routes
app.use('/', indexRouter);
app.use('/local', localRouter);
app.use('/collection', collectionRouter);
app.use('/external', externalRouter);

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
