## Overview

Express is written in JavaScript and does not bundle its own type definitions. Historically, this project was written in Javascript so it could run natively, but underwent a partial migration to Typescript to make database/entity management less error-prone. 
To handle the partial migration, the project uses a command, `npm run build`, to compile all the .ts files to `/build` and runs the server as Javascript. Some files (`app.js`, `routes/`, `util/`) are still plain Javascript and are edited directly in the source tree. These are the last holdouts.
The current testing framework (Mocha/Supertest) was chosen partially because it could accept a .js/.ts split in the codebase. However, more features are planned, and the files that are still JS are likely the simplest they'll ever be right now, so it makes sense to finalize the conversion and switch them over to Typescript.

## Problems

- `app.js`, the files in `routes/`, and `util/` are Javascript files and need to be converted to Typescript.

## Spec

- Convert `app.js`, the files in `routes/`, and `util/` to Typescript.
- Update the CommonJS `require()` imports to the more modern ESM format.
- Add the new Typescript files to the `npm run build` command, so they recompile on build the same as the other Typescript files in the project.
- Investigate if the current Mocha/Supertest implementation can be simplified as a result of this change. If the changes are minor, work them into this implementation.

### Decisions
- **ESM syntax, CommonJS output.** Source files use `import`/`export`, but `tsconfig.json` keeps `module: "commonjs"`. The project does not switch to `"type": "module"`.
- **`bin/www` is converted too**, to `bin/www.ts`. `npm start` runs `build/bin/www.js`.
- **`routes/users.js` is deleted.** It isn't mounted or imported anywhere.
- **`util/httpRequests.js` is converted with its behavior unchanged.** It's unused for now and kept for the planned `/external` work.

## Out of Scope
- **Existing requests are served while startup sync is still running.** `app.locals.db` resolves when the connection opens, not when sync finishes. This will be addressed in the next spec (`/media-route`).
- **Errors render as an HTML page.** The error handler in `app.js` renders the pug error page for every route, including unknown API paths, so the front end gets HTML instead of JSON. This will also be addressed in the next spec.
- **Existing requests in `/routes` are stubs** that return placeholder text with status 200, so a client can't tell they don't work.

## Acceptance Criteria

- After conversion, the server starts with `npm start` in the same state it did prior to the conversion.
- Making a request of `/media` returns the same input it did prior to the conversion.