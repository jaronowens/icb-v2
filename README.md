## Overview
The Image Collection Backend (ICB) is a REST API that indexes image files and video files (primarily mp4s) from local directories that are provided at runtime from `/directories.json`, and stores them in a Sqlite database along with relevant metadata.

When a call is made, the API finds image nodes in the database that match the request parameters and responds with JSON objects that provide links to the image or video, along with metadata about the images.

This is a hobby project, and as such is currently intended to run locally, and be accessed by a front-end that also runs locally.

## Technical Specifications
The API uses Express.js for server logic, and a simple Sqlite database to store working data. Currently, the database is dropped and re-made at server runtime.

## Usage and available scripts

``npm run build``

Deletes `/build`, compiles all Typescript (and the plain Javascript files) into `/build` with the same directory structure as the project root, then copies runtime assets (`bin/www`, `directories.json`, `views/`, `public/`) into it. The build fails without emitting anything if there are type errors.

``npm start``

Runs a fresh build (via `prestart`), then starts the server from `build/bin/www`.

``npm run clean``

Deletes the `/build` directory.

## Explanations
This project is very much a work in progress, and as such has a few messy choices and stubbed functions that will be cleaned up or expanded upon.

### Use of both Javascript and Typescript
The project is primarily written in Typescript, but runs as Javascript to keep the Express/Sqlite3 integration simpler. Some files (`app.js`, `bin/www`, `routes/`, `util/`) are still plain Javascript and should be edited directly in the source tree, alongside the `.ts` files.

Compiled output lives only in `/build`, which is git-ignored and regenerated on every build. Never edit files in `/build`. Changes to `directories.json`, `views/`, or `public/` are copied at build time, so they take effect on the next `npm start`.