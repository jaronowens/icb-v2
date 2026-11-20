The project runs on Express 4 (`express@4.22.3`). Express 5 is the current major version (5.3.0 at the time of writing). The upgrade comes before the route overhaul (`specs/06-media-route/`), because Express 5 changes how routes are written and how errors in them are handled.

## Why upgrade
- **Errors in async route handlers reach the error handler.** In Express 4, a rejected promise in a handler is never caught, so it either crashes the server (what `/media` does today) or leaves the request hanging. Express 5 passes it to `next(err)` automatically, so handlers can be plain `async` functions.
- Express 4 is in maintenance. New features, fixes and middleware target 5.
- It requires Node 18 or later. The project uses Node 23 (Volta).

## Breaking changes that affect this project

| Change in Express 5 | Where it hits | What to do |
| --- | --- | --- |
| Route path syntax is stricter (path-to-regexp v8). A bare `*` is no longer allowed: wildcards need a name, such as `/*splat`. Characters like `(`, `)`, `[`, `]`, `?`, `+` and `!` are reserved, and using them unescaped throws an error when the route is registered. | `routes/external.js`: `router.get('/*', ...)` | Change it to `/{*splat}`. The braces make it optional, so it also matches `/external/`, as the Express 4 version did. |
| Same as above | `app.js`: the CDN mounts each directory at `` `/${directory.name}` ``, using names from `directories.json` | Validate directory names at startup: letters, digits, `-` and `_` only. An invalid name logs a clear error and that directory is skipped, instead of the server failing on a path-syntax error. The current name, `hydrus`, is valid. |
| The default query parser changed from `extended` (nested objects and arrays, via `qs`) to `simple`. | `app.js` has `app.set('query parser'), function (str) {...}`, which was meant to set the parser but does nothing: the parenthesis closes too early, so the function is never passed in. It also `require`s `qs`, which isn't in `package.json` and only works because Express installs it. | Replace the line with `app.set('query parser', 'extended')` and remove the `qs` require. That keeps today's behavior. No routes read the query string yet, so this mainly sets up pagination and filters later. |
| Rejected promises in handlers go to the error handler. | `routes/media.js`: `GET /` runs its query in `open().then(...)` with no `.catch`. | Rewrite that handler as an `async` function that awaits the query, so a failed query becomes a 500 instead of a crash. The other problems with this route (a new connection on every request, stubbed methods and so on) stay in `specs/06-media-route/`. |
| `res.status()` only accepts integers from 100 to 999 and throws otherwise. | `app.js` error handler: `res.status(err.status \|\| 500)` | No change needed. Errors without a status still get 500, and `http-errors` always sets a valid one. |

## Checked and not affected
Removed or changed in Express 5, but not used here: `req.param()`, `res.send(status)` and `res.json(obj, status)`, `res.redirect('back')`, `res.sendfile`, `app.del`, `req.host` (now includes the port), and assigning to `req.query` (now read-only).

Middleware: `cors`, `morgan`, `cookie-parser`, `http-errors` and `pug` work with Express 5 unchanged. `express.json()` and `express.urlencoded({ extended: false })` now come from body-parser 2, and the options used here behave the same.

`express.static` now ignores dotfiles by default, so hidden files (names starting with `.`) in a media directory are no longer served. Startup sync still indexes them, so they show up in `/media` but their URLs would 404. Hidden files in the media folders aren't expected, so this is noted rather than handled.

## Spec
- Upgrade `express` to `^5.3.0` and update `package-lock.json`.
- Make the changes in the table above.
- Nothing else changes: every existing route keeps its path and response.

## Out of scope
- Everything in `specs/06-media-route/`: the shared connection, readiness, JSON errors, `GET /media/:id` and the stubbed methods. That spec will be revised to rely on Express 5 once the planned routes are written up.
- Upgrading the other dependencies (`http-errors`, `debug` and so on).

## Acceptance
- `npm start` builds and the server starts. Startup sync and `Database ready` are unchanged.
- `GET /media` and `GET /local` return the same responses as before the upgrade.
- `GET /external/anything` and `GET /external/` both return the "unsupported external site" response.
- Media files are still served from `/<directory name>/<file>`.
- A directory in `directories.json` with an invalid name (such as `my (pics)`) logs an error and is skipped, and the server keeps running.
- A failed `/media` query returns a 500 and the server keeps running. Test this by temporarily breaking the query.
- A query string like `?a[b]=1` is parsed as a nested object (`req.query.a.b === '1'`).

## Resources
- Express 5 migration guide: https://expressjs.com/en/guide/migrating-5.html. The full list of breaking changes.
- path-to-regexp (the library Express 5 uses for route paths): https://github.com/pillarjs/path-to-regexp. Its README explains the new wildcard and optional syntax.
