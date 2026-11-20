The next step in building ICB is to add support for tags. A tag is a small bit of text describing a single property of a Media node, intended to make searching easier.

## Tag storage

Originally, the database was planned to use a space-delimited string as storage for all tags assigned to the media node. However, after further research, I would like to alter this so that Tags is its own table with a many-to-many relationship to Media. This should make it easier to search by tags without having to do lots of service logic, and it also makes the planned Hydrus integration simpler. (Hydrus' tag storage method is more complicated because it has multiple tag domains. This isn't currently planned for ICB, but it should still make integrating data from the Hydrus Client API simpler if we use this tag structure).

## Percent-encoded JSON
In order to successfully transmit an array through a query parameter, we will use Hydrus's JSON-URL-encoded scheme for endpoints that accept tags as a query parameter. This stucture is explained in detail at `/specs/08-hydrus-research/API/General Information.md`.

## Problems

- There is no Tags table currently in the database.
- The `tags` column in `Media` is currently a string. It needs to be reworked to be a reference to a linking table.
- The above tasks will require a database migration.
- The routes under `/media` currently return the string value of the `tags` field--this will need to be reworked to be an array of all associated tags.

## Spec

- Create a new database table called Tags. Each row in Tags holds a string value for the actual tag, and a reference to the linking table between Tags and Media.
    - Tags should be unique.
    - A Media node can have no associated tags.
- Alter GET requests from `/media` and `/media:id` to return an array of tags that are associated with each Media node, in addition to the other fields it currently returns.
- Add a new endpoint, `/tags`, that allows for creation, deletion, and editing of tag values.
    - `GET` returns a list of all tags currently in the database.
    - `GET :tagName` returns the tag, along with a count of how many associated Media nodes the tag has in the database.
    - `POST/:tagName` adds a new tag to the database. Trying to add a duplicate tag instead returns a link to the original tag and does not add a new entry.
    - `PUT :tagName` allows for the tag to be renamed.
        - Returns the name of the new tag if successful.
        - Editing a tag to a name that already exists merges the two and re-links all existing Media nodes.
    - `DELETE :tagName` deletes the tag and unlinks all associated Media nodes from the tag.
    - Trying to access a tag that doesn't exist with `GET`, `PUT`, or `DELETE` returns `404`.
- Build out the `PUT /media:id` endpoint to allow for the assignment/deletion of tags to a single Media node.
    - This endpoint expects a JSON-URL-encoded array as a query parameter. Ill-formatted parameters respond `400`.
    - A tag in this array that doesn't currently exist creates a new tag and links the media node to it.
    - A tag that is currently assigned to the media node, but not in this array, gets its association removed.
    - Trying to edit a node that doesn't exist returns `404`.

## Out of Spec
- Searching Media nodes by tags or other data. Since this task already has a lot of new parts, I would rather split that into a second part once it's confirmed all of this is working.

## Testing/Acceptance

**Note:** Tags were added to the README for the fixtures in the testing folder. Use these tags to test thease features with.