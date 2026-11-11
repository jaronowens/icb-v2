## Overview

The Image Collection Backend (ICB) is a REST API that indexes image files and web-safe video files from local directories that are provided at runtime from `/directories.json`, and stores them in a Sqlite database along with relevant metadata. These images are then made available at various endpoints that allow for organization, filtering, and displaying the media in a front-end application.

This is a hobby project, and as such is currently intended to run locally, and be accessed by a front-end that also runs locally.

### Media
Images and videos that are loaded into the app are saved in the database as Media nodes. Media nodes will eventually be available from multiple sources, but currently only local media is supported.

Media nodes persist between server restarts, and images are linked to their relevant data based on an image hash. If a media node that was once available to the server is not available during startup, it unmounts from the list of active nodes, but its data is saved. If you ever re-link the same image, the relevant data should show back up, even if the location or filename changes.

Currently, duplicate images are automatically merged into the same Media node. This should work even if the image is compressed differently or resized, but it's not foolproof and some edge cases might slip through. A more robust system to sort out near-matches is planned as a future feature.

#### Loading Local Media
In order to use ICB, first load images that you want to be made available. On server start, the app checks `directories.json` for each `name`/`path` provided, and either creates or re-mounts the images to media nodes.

**Note:** The image hash generation process is slow, so loading a lot of new images into the database can cause delays in startup the first time. After the hashes have been generated, they aren't regenerated unless a change is detected, so subsequent startups should be much faster.

## Technical Specifications

The API uses Express.js for server logic, and a simple Sqlite database to store data.

When a call is made, the API finds image nodes in the database that match the request parameters and responds with JSON objects that provide links to the image or video, along with metadata about the images.

### Use of Javascript and Typescript

The project is primarily written in Typescript, but runs as Javascript to keep the Express/Sqlite3 integration simpler. Some files (`app.js`, `bin/www`, `routes/`, `util/`) are still plain Javascript and should be edited directly in the source tree, alongside the `.ts` files.

Compiled output lives only in `/build`, which is git-ignored and regenerated on every build. Never edit files in `/build`. Changes to `directories.json`, `views/`, or `public/` are copied at build time, so they take effect on the next `npm start`.

## Usage and available scripts

### Endpoints

*This section is a stub and will be expanded upon as more endpoints are added.*
#### All Endpoints:

| Route    | Method | Function                                                                                              |
| -------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `/media` | GET    | Returns a list of all images in the database.                                                         |
| `/media` | *POST* | *this method doesn't actually exist, but if it did a short description of its function would go here* |


*Detailed usage descriptions of endpoints and their usage will go under the headers below as they are created.*
#### `/media`

#### `/collections`

#### `/profile`

#### `/hydrus`

### Available Commands
``npm run build``

Deletes `/build`, compiles all Typescript (and the plain Javascript files) into `/build` with the same directory structure as the project root, then copies runtime assets (`bin/www`, `directories.json`, `views/`, `public/`) into it. The build fails without emitting anything if there are type errors.

``npm start``

Runs a fresh build (via `prestart`), then starts the server from `build/bin/www`.

``npm run clean``

Deletes the `/build` directory.

``npm test``

Runs the test suite with Mocha. Tests run against the source through `tsx`, so there's no need to build first. Set `TEST_LOGS=1` to see the app's console output, which is silenced during tests by default.

## Testing

Tests use [Mocha](https://mochajs.org/) as the runner, [Supertest](https://www.npmjs.com/package/supertest) for requests against the app, and `node:assert` for assertions. They never touch `./db/media.sqlite3` or the folders in `directories.json`: each suite gets a fresh in-memory database, and the app serves `test/fixtures/images/` at `/fixtures`.

- `test/unit/` for repository and service functions, called directly with a test database.
- `test/integration/` for HTTP requests against the app.
- Name test files `<module>.test.ts` (or `.js`) after the module they cover.

Helpers in `test/helpers/index.ts`:

- `createTestDb()`: a fresh in-memory database with the current schema.
- `createTestApp({ directories, sync })`: the app on a fresh test database, serving the fixtures by default. Runs startup sync and waits for it unless `sync` is `false`. Returns `{ app, db }`.

Close the database from either helper with `db.close()` when the test or suite is done. `test/fixtures/README.md` lists what each fixture file covers.

The app is built by `createApp({ db, directories })` in `app.js`, which has no side effects. `bin/www` opens the real database and runs startup sync (`startup` in `service/startupService.ts`), so tests can build the app against anything.

## Planned Features

The features below are planned to be implemented. They are listed roughly in order of dependency and/or priority (features closer to the top should be implemented sooner to make less work for features towards the bottom). If we discover blockers, the list can be re-ordered.

| Planned Feature                                                         | Description                                                                                                                                                                                                                        | Implemented? | Spec?                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------ |
| Local Media Loading                                                     | Load media from local sources.                                                                                                                                                                                                     | ✅            | -                                          |
| Persistence                                                             | Media nodes persist between server start/stop.                                                                                                                                                                                     | ✅            | [yes](specs\persistence\spec.md)           |
| Local Media Data                                                        | Determine `width` and `height` for local media and add it to the imports.                                                                                                                                                          | ✅            | [yes](\specs\local-media-data\spec.md)                                          |
| Testing Framework                                                       | Add a testing framework to the project to make unit and/or integration tests more accessible and reliable.                                                                                                                         | ✅            | [yes](specs\testing-framework\spec.md)  |
| Route Reliability                                                       | Make the existing `/media` and `/local` routes reliable: share one database connection, answer `503` until startup sync finishes (with a `/status` endpoint), and return JSON errors instead of crashing or rendering HTML.        | ❌            | [yes](specs\media-route\spec.md)        |
| Media Endpoints                                                         | Add endpoints that expose CRUD functions on media nodes via API request.                                                                                                                                                           | ❌            | -                                       |
| Background Hashing                                                      | Rework the image hash generation to happen independently of server initialization.                                                                                                                                                 | ❌            | -                                          |
| Hydrus Research                                                         | Review Hydrus's data model (tags, ratings, duplicate/alternate relationships, SHA-256 file hashes) so the features below are designed to sync with it later.                                                                       | ❌            | -                                          |
| Tags                                                                    | Add tags to media, and expose endpoints that allow for media to be searched by tags.                                                                                                                                               | ❌            | -                                          |
| Near-match comparison                                                   | Find pairs of images whose hashes are _close_ but not equal, and let the user decide what each pair is.                                                                                                                            | ❌            | [yes](specs\near-match-duplicates\spec.md) |
| Remote Image Loading                                                    | Load media from an external API (i.e. boorus), choose what to add to the database (and save locally).                                                                                                                              | ❌            | -                                          |
| User profiles                                                           | Optional profile system to associate user data and collections with different users.                                                                                                                                               | ❌            | -                                          |
| Collections                                                             | Add media to a collection that is saved to the database, then expose endpoints to manage that collection.                                                                                                                          | ❌            | -                                          |
| User Data                                                               | Set media as favorites, and collect usage data on media. Expose endpoints to allow for user data to be changed by API requests with the proper permissions.                                                                        | ❌            | -                                          |
| [Hydrus](https://hydrusnetwork.github.io/hydrus/index.html) Integration | Uses the [Hydrus Client API]([https://hydrusnetwork.github.io/hydrus/](https://hydrusnetwork.github.io/hydrus/client_api.html)) to sync ICB's state with Hydrus and allow for changes to relevant user data to also affect Hydrus. | ❌            | -                                          |


