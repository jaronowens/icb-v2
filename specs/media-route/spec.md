The `/media` route was put together for testing early on. Now that the database persists (`specs/persistence/`), it is the main way the front end reads data, and it needs to be both reliable and an example for later endpoints to follow.

## Already done
- **Shared connection for `/media`.** `app.ts` stores the promise for the connection it opens at startup in `app.locals.db`. `GET /media` awaits it instead of opening a new connection on every request. A request that arrives before the connection is open waits for it, and gets a 500 if opening failed.

## Problems
- **Requests are served while startup sync is still running.** `app.locals.db` resolves when the connection opens, not when sync finishes. On a first start (or after many files change) hashing takes minutes, and `/media` returns partial or changing results in the meantime.
- **Errors render as an HTML page.** The error handler in `app.ts` renders the pug error page for every route, including unknown API paths, so the front end gets HTML instead of JSON.
- **`POST`, `PUT` and `DELETE /media` are stubs** that return placeholder text with status 200, so a client can't tell they don't work.
- **There's no way to fetch one media item**, or to see every file behind a Media row (its duplicates). `/media` only returns the representative file.

## Spec

### Database connection
- All routes use the shared connection from `app.locals.db`.

### Readiness
- The server tracks whether the database is ready: `starting` until startup sync logs `Database ready`, then `ready`, or `failed` if startup throws.
- While the database is `starting`, `/media` responds `503 Service Unavailable` with a `Retry-After` header, instead of reading a database that's mid-sync.
- If startup `failed`, it responds `503` with an error saying the database failed to initialize. The server keeps running, so the failure can be read in the response and in the log.
- A new `GET /status` returns `{ "database": "starting" | "ready" | "failed" }` with status 200, so the front end can wait for the server to be ready. It's also groundwork for Background Hashing, which would add progress to it later.

### Errors
- Route handlers are `async` and let errors reach the error handler, which Express 5 does on its own. No handler swallows an error or responds with `undefined`.
- API routes (everything except `/`) respond to errors with JSON: `{ "error": "<message>" }` and the right status code. The pug error page stays for `/`. In development the response also includes the stack trace, as the error page does now.
- Unknown API paths respond `404` with JSON.

### `GET /media`
- The response is unchanged: an array of mounted media, one entry per Media row, using its representative file.

### `GET /media/:id` (new)
- `:id` must be a positive integer, otherwise `400`.
- An id with no Media row is `404`.
- Returns the same fields as an entry in `GET /media`, plus:
  - `isMounted` (boolean)
  - `files`: every `Local` row linked to it (`id`, `name`, `extension`, `is_video`, `imageURL`, `previewURL`, `source`), ordered by `id`, so the representative comes first.
- Unmounted media can be fetched by id. They have `isMounted: false` and an empty `files` list, and their own fields come from the Media row alone (no name or URLs). This keeps their tags reachable.

### `GET /media/unmounted` (new)
- Returns an array of all media rows that are currently unmounted (`isMounted: false`).

### `POST /media` (new)
- Creates a new Media row in the database.
- Expects a JSON request body that contains a valid filepath.
- Only accepts supported media types.
- Returns `201` with the ID of the new row, or `400` if the filepath was invalid.

### `PUT`, `DELETE /media`
- Respond `501 Not Implemented` with a JSON error until they're designed.
 - Editing tags (`PUT /media/:id`) is expected to come with the Tags feature, in a later spec.
 - Deleting media needs a "blacklist" of imageHashes stored in the database so they can be omitted even if they're still present in mounted directories. This should also be its own spec.

## Out of scope
- Editing tags or other Media fields (`PUT /media/:id`).
- Pagination for `GET /media`. About 250 KB for 670 rows is fine for now.
- The `/collection` and `/external` stubs.
- Hashing in the background (Background Hashing), beyond adding the `/status` endpoint it will use.

## Acceptance
- While the first start is still hashing, `/media` responds `503` with `Retry-After`, and `/status` reports `starting`. After `Database ready`, `/status` reports `ready` and `/media` responds normally.
- A query that fails (for example, against a broken table) gives a `500` JSON error, and the server keeps serving the next request.
- `GET /media` returns exactly the same response as before this change.
- `GET /media/:id` returns the item and all of its files for a duplicate pair, `isMounted: false` with no files for an unmounted row, `404` for a missing id and `400` for `abc` or `0`.
- `POST /media` with a valid filepath creates a new Media node in the server and a new Local node with the related image data. A broken file link or an incorrect file type returns `400`.
- `PUT` and `DELETE /media` respond `501`.
- An unknown API path such as `/media/1/nope` returns a `404` JSON error.
