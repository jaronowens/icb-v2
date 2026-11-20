## Overview
When the app was first being prototyped, it was uncertain as to whether heights and widths would be necessary for the front end to display images at the proper aspect ratio,Space was planned in the entiies in case it would be needed in the future. However, the height and width of the file could not be determined, so early functions ignored this value, or naively set it to 0.
However, now that more functionality has been added, this has led to a situation where `height` and `width` are being handled inconsistently.

## Problems
- In `repository/schema.ts`, columns are not being created for `height` or `width`, but they are listed in the entities.
- `initializeLocalNode` in `localFileService.ts` is setting both `height` and `width` to 0 instead of interpreting and reading from the file.
- `getMediaNodes` in `mediaService.ts` is ignoring the potential values of `height` and `width` and is instead reinforcing the 0.
- `populateMediaFromSource` in `repository/media.ts` also does not add these values to the database.

## Spec

- Create height/width columns in the Local table in the database. This will require a database migration (1 > 2).
- Use the [image-size](https://www.npmjs.com/package/image-size) module to interpret the image's size and set its value in the database.
- Update `initializeLocalNode`, `getMediaNodes`, and `populateMediaFromSource` to properly set and/or read height and width.
- For media types that image-size cannot work on (or fail to be read), set the height and width to NULL.

## Acceptance Criteria

- Existing files that have valid file types have heights and widths stored in the database.
- New files that are valid get correct dimensions stored when added.
- Unknown media types return NULL.
- Accessing the GET /media endpoint returns real values. 