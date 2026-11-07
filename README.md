## Overview
The Image Collection Backend (ICB) is a REST API that indexes image files and video files (primarily mp4s) from local directories that are provided at runtime from `/directories.json`, and stores them in a Sqlite database along with relevant metadata.

When a call is made, the API finds image nodes in the database that match the request parameters and responds with JSON objects that provide links to the image or video, along with metadata about the images.

This is a hobby project, and as such is currently intended to run locally, and be accessed by a front-end that also runs locally.

## Technical Specifications
The API uses Express.js for server logic, and a simple Sqlite database to store working data. Currently, the database is dropped and re-made at server runtime.

## Usage and available scripts

``npm start``

This runs the current built version of icb in the terminal.

## Explanations
This project is very much a work in progress, and as such has a few messy choices and stubbed functions that will be cleaned up or expanded upon.

### Use of both Javascript and Typescript
The project is primarily written in Typescript, but runs as Javascript to keep the Express/Sqlite3 integration simpler. If you encounter two files with the same name in the same directory (e.g. `mediaService.js` and `mediaService.ts`), the JS file is the compiled one and should not be edited directly. Instead, compile the TS and overwrite the JS file.
The most notable exception to this is `app.js`, which is the root of the project. This code should be edited directly.