The current Sqlite relational database setup in this project has issues that have stopped it from seeing full implementation into the project at large.

## imageURL is being used as the source of truth
The URL of the image (stored as `mediaNode.imageURL`, or `Media.imageURL` and `Local.imageURL` in the database) is being used as the source of truth for comparisons, but this has flaws. For example, it is fundamentally unable to distinguish between duplicate images, or to detect if an image has changed outside of its filename. I would like to refactor the database to use an image hash instead.
### Spec
Use [image-hash](https://www.npmjs.com/package/image-hash) to generate image hashes from images that are loaded in. Store these image hashes in the respective entity and make columns for them in the respective database.
Refactor `synchronizeFromMedia()` and `syncUnlinkedLocalNodes()` to compare based on the image hash instead of the image URL.
The existing SQL in the project may have errors, so if you run into any faults, please explain them in `/specs/convert-to-image-hash/sql-problems.md` so I can use the document as an educational exercise.

## Data is not persisted between server starts/stops
> **Moved:** this work now has its own spec and implementation plan in `specs/persistence/`. The text below is kept for history.

Currently, the repository is set up to drop and recreate the database on server start, but this is not the intended behavior. Ideally, the database should persist between server starts/stops, and when the server starts it should synchronize entries between the database and the images passed in. `populateMediaFromSource()`, `syncUnlinkedLocalNodes()`, and `synchronizeMedia()` are attempts to do this, but they all have issues.
**Post image-hash update**: Data persistence was originally turned off because of previously unresolved issues with SQL queries and a race condition in app.js. These were addressed as a part of the image-hash work, so the persistence work should be much easier.
### Spec
- Remove the `drop` boolean arguments from the `initializeLocalDB` and `initializeMediaDB` function calls in app.js. This should toggle off the "drop on startup" behavior.
- Once the database persists, store `size` and `mtime` for each node on Local and only re-hash files where either one changed. This should make startup much faster.
- `Media.imageHash UNIQUE` plus `INSERT ... WHERE imageHash NOT IN (...)` is already safe to run more than once, which persistence needs.

#### Note
Since generating hashes takes significantly longer than other startup functions, it could be worth exploring having the hashing happen as a background function while the server is running. However, as this would require a refactor of the initialization logic, it may be best explored as a separate spec.

claude --resume 57915315-0a18-4665-a85d-f5b93509e5a9