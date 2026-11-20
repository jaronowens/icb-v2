# Implementation Plan: Tags

Implements `specs/tags/spec.md`.

## Decisions

| Topic | Decision |
| --- | --- |
| Tables | `Tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)` and a linking table `Media_Tags (mediaID INTEGER NOT NULL, tagID INTEGER NOT NULL, PRIMARY KEY (mediaID, tagID))`, with an index on `Media_Tags(tagID)`. The spec describes Tags as holding "a reference to the linking table". In a many-to-many relationship the reference actually goes the other way: each `Media_Tags` row points at one tag and one Media row. A Media row with no tags has no `Media_Tags` rows. |
| Foreign keys | `REFERENCES Media(id)` and `REFERENCES Tags(id)` are declared as documentation, but nothing relies on them. `PRAGMA foreign_keys` is off in this app, and turning it on is risky: `Media` already references tables that don't exist (`Collections_Media`, `UserData`). The service deletes links explicitly. |
| Normalization | Every tag goes through `normalizeTag`, whether it comes from a path, a body or a query array. It trims, collapses runs of whitespace into one space, and lowercases (`toLowerCase()`; the ASCII-only `lower()` in SQL isn't used). A tag that's empty after this gets a `400`. Path lookups are normalized too, so `GET /tags/Elf` finds `elf`. |
| Migration | Migration 4 creates both tables and runs `ALTER TABLE Media DROP COLUMN tags`. Nothing ever wrote to `Media.tags`, so no data is carried over. The bundled SQLite is 3.52, which supports `DROP COLUMN` (3.35+) and `json_group_array`. |
| `tags` in `/media` responses | A `string[]` sorted by name, `[]` when the media has none. The key stays in the same position, so `MEDIA_NODE_KEYS` doesn't change. It's read with a correlated `json_group_array` subquery and parsed in `toMediaNode`. That keeps the query count unchanged, and unlike `GROUP_CONCAT` it's safe for tags that contain commas. This applies to `/media`, `/media/:id` and `/media/unmounted`. |
| Gating | `/tags` sits behind `requireDatabase`, the same as `/media`. |
| Writes | Every write (`PUT /media/:id`, and `POST`/`PUT`/`DELETE /tags/:tagName`) runs inside `withTransaction`. |
| Tag names in URLs | Clients percent-encode them, and Express decodes `req.params` (`%3A` → `:`, `%20` → space, `%2F` → `/`). The server builds URLs with `/tags/${encodeURIComponent(name)}`. |
| `GET /tags` | `200` with a `string[]` of every tag, sorted by name. |
| `GET /tags/:tagName` | `200 { name, count }`. `count` is the number of Media rows linked to the tag, mounted or not. Unknown tag → `404`. |
| `POST /tags/:tagName` | A new tag gets `201 { name, url }`. An existing tag gets `200 { name, url }` and nothing is inserted. Both responses set a `Location: /tags/<name>` header. `name` is the normalized name. |
| `PUT /tags/:tagName` | The body is `{ "name": "<new name>" }`. A missing name, a non-string or an empty name → `400`. An unknown tag → `404`. If the new name is free, the row is renamed. If another tag already has that name, the two merge: links move to the existing tag (`INSERT OR IGNORE`, so media that had both tags end up with one link), then the old tag is deleted. A new name that normalizes to the same name is a no-op. Every success returns `200 { name, url }` with the resulting name. |
| `DELETE /tags/:tagName` | Removes the tag's links and then the tag. Returns `204`, or `404` for an unknown tag. |
| Unused tags | Tags stay in the table when no media use them anymore. `POST /tags` creates tags with no media, so a tag with nothing linked is a valid state. |
| `PUT /media/:id` input | The query parameter is `tags`, holding a JSON-URL-encoded array of strings, for example `?tags=%5B%22elf%22%2C%22sfw%22%5D`. The app's `extended` query parser leaves that as a plain string. These get a `400`: a missing parameter, a parameter that isn't a single string (for example `?tags[]=a`, which qs turns into an array), JSON that doesn't parse, JSON that isn't an array, an array with a non-string in it, and a tag that's empty after normalization. Duplicates after normalization are collapsed. `[]` removes every tag. |
| `PUT /media/:id` behaviour | The array **replaces** the media's tags. Tags that don't exist yet are created, links missing from the array are removed, and existing links are kept. An invalid id → `400` (`parseId`), an unknown id → `404`. Unmounted media can be tagged too, because tags belong to the Media row. |
| `PUT /media/:id` response | `200` with the same body as `GET /media/:id`, so the client sees the result. |
| `PUT /media` (no id) | Removed: it's no longer planned. The route is deleted, so the request falls through to the app's catch-all and gets `404`. |
| `DELETE /media[/:id]` | Unchanged: `501`. |

---

## Step 1: Migration 4, `repository/schema.ts`

```ts
const CURRENT_VERSION: number = 4;

// 3 -> 4: tags move from a string column on Media into their own table (specs/tags).
// Media.tags was never written to, so there's nothing to carry over.
4: async (db) => {
    await db.run(`CREATE TABLE Tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE)`);
    await db.run(`CREATE TABLE Media_Tags (
        mediaID INTEGER NOT NULL REFERENCES Media(id),
        tagID INTEGER NOT NULL REFERENCES Tags(id),
        PRIMARY KEY (mediaID, tagID))`);
    // the primary key covers lookups by mediaID; this one covers counts, renames and deletes by tag
    await db.run('CREATE INDEX idx_media_tags_tagID ON Media_Tags(tagID)');
    await db.run('ALTER TABLE Media DROP COLUMN tags');
},
```

Also update the comment in `specs/persistence/schemas-and-migrations.md` that sketches this migration, or leave it as historical. That's your call; the plan leaves it alone.

## Step 2: Media repository, `repository/media.ts`

- Remove `tags` from the two `INSERT INTO Media (...)` column lists (`populateMediaFromSource`, `insertMedia`).
- In `getMedia`, `getMediaById` and `getUnmountedMedia`, replace `Media.tags` with:

```sql
(SELECT json_group_array(name) FROM (
    SELECT Tags.name FROM Media_Tags JOIN Tags ON Tags.id = Media_Tags.tagID
    WHERE Media_Tags.mediaID = Media.id ORDER BY Tags.name)) AS tags
```

  Keep it in a shared constant (`TAGS_COLUMN`) so all three queries use the same SQL. `getUnmountedMedia` needs `FROM Media` to be referenced as `Media` for the correlation to work, so it qualifies its columns.

## Step 3: Tag repository, `repository/tags.ts` (new)

These are thin SQL functions. None of them opens a transaction.

```ts
getAllTagNames(db): Promise<string[]>                      // ORDER BY name
getTagByName(db, name): Promise<{ id, name } | undefined>
countMediaForTag(db, tagID): Promise<number>
insertTag(db, name): Promise<number>                        // returns lastID
renameTag(db, tagID, name): Promise<void>
deleteTag(db, tagID): Promise<void>                         // deletes links first, then the row
moveTagLinks(db, fromTagID, toTagID): Promise<void>         // INSERT OR IGNORE ... SELECT, then DELETE the old links
getTagIDsForMedia(db, mediaID): Promise<number[]>
linkTag(db, mediaID, tagID) / unlinkTag(db, mediaID, tagID)
```

## Step 4: Entities, `entity/mediaNode.ts` and `entity/tag.ts` (new)

- `MediaNode.tags: string[]`.
- `entity/tag.ts`: `interface TagDetail { name: string; count: number }` and `interface TagRef { name: string; url: string }`.

## Step 5: Tag service, `service/tagService.ts` (new)

```ts
/* Trim, collapse whitespace, lowercase. Throws 400 if nothing is left. */
const normalizeTag = (raw: unknown): string => { ... };

const tagURL = (name: string) => `/tags/${encodeURIComponent(name)}`;

listTags(db): Promise<string[]>
getTagDetail(db, rawName): Promise<TagDetail>                         // 404 if missing
createTag(db, rawName): Promise<{ tag: TagRef, created: boolean }>    // the lookup runs inside withTransaction
renameOrMergeTag(db, rawName, rawNewName): Promise<TagRef>            // 404 / 400 as in Decisions
removeTag(db, rawName): Promise<void>                                 // 404 if missing

/* Replaces a Media row's tags. Throws 404 if the row doesn't exist. */
setMediaTags(db, mediaID, names: string[]): Promise<void>
```

`setMediaTags` checks that the Media row exists inside the transaction. It then finds or creates the tag ID for each name, compares the result with `getTagIDsForMedia`, and links or unlinks only what changed.

## Step 6: JSON-URL parameter parsing, `util/queryParams.ts` (new)

```ts
/* Parses a Hydrus-style JSON-URL-encoded string array (specs/hydrus-research/API/General Information.md). Throws 400. */
const parseJsonStringArray = (raw: unknown, name: string): string[] => { ... };
```

Express has already URL-decoded the value, so only `JSON.parse` is left to do. This lives in `util/` so the planned tag search can reuse it.

## Step 7: Media service and routes

- `service/mediaService.ts`: `toMediaNode` and `unmountedNode` set `tags: JSON.parse(row.tags)`. Add `updateMediaTags(db, id, rawTags)`. It parses the parameter, normalizes and deduplicates the tags, calls `setMediaTags`, and returns `getMediaDetail(db, id)`.
- `routes/media.ts`: replace the `PUT /:id` 501 with:

```ts
router.put('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const db = await req.app.locals.db;
    res.json(await updateMediaTags(db, id, req.query.tags));
});
```

  The `router.put(['/', '/:id'], ...)` 501 handler is removed completely. `PUT /media` isn't planned anymore, so it now gets the catch-all `404`.

## Step 8: Tags router, `routes/tags.ts` (new), wired in `app.ts`

```ts
router.get('/', ...)              // listTags
router.get('/:tagName', ...)      // getTagDetail
router.post('/:tagName', ...)     // createTag → res.location(tag.url).status(created ? 201 : 200).json(tag)
router.put('/:tagName', ...)      // renameOrMergeTag(db, req.params.tagName, req.body?.name)
router.delete('/:tagName', ...)   // removeTag → res.sendStatus(204)
```

`app.ts`: `app.use('/tags', requireDatabase, tagsRouter);`

## Step 9: Fixtures

- Fix the table in `test/fixtures/README.md`. The current edit moved the `| --- |` separator under the header into the middle of the table, so the table no longer renders. The second-section rows are also missing their closing `|`, and the section divider row needs a fourth column.
- Add `test/fixtures/tags.ts`, which exports `FIXTURE_TAGS: Record<fileName, string[]>` copied from the README. Tests use this file; the README is documentation.
- Add `tagFixtures(app)` in `test/helpers/index.ts`. It reads `GET /media`, then sends `PUT /media/:id?tags=...` for each entry using `FIXTURE_TAGS[entry.name]`. Fixtures that share a Media row (`scene-a.png` and `scene-a-copy.png`) have the same tags, so it doesn't matter which one is the representative.
- `notes.txt` is skipped by sync, so its tags can never be applied. Leave it out of `FIXTURE_TAGS`, or keep it and have `tagFixtures` skip names with no Media row.

## Step 10: Tests

Update the existing tests:
- `test/unit/schema.test.ts`: the table list becomes `['Local', 'Media', 'Media_Tags', 'Tags']`, and `Media` no longer has a `tags` column. Add a test that migrates a v3 database with existing Media rows to v4, and checks that the rows and their ids are kept.
- `test/integration/media.test.ts`, `mediaPost.test.ts` and `test/unit/rekey.test.ts`: these insert `Media.tags` strings directly. Insert `Tags`/`Media_Tags` rows instead, using a small `insertTagLink(db, mediaID, name)` test helper, and assert `tags` as arrays. The rekey test "keeps the Media row id and tags" now checks that the links still point at the kept id.
- Take `PUT /media/1` and `PUT /media` out of the 501 loop, so it only checks `DELETE`. Add a test that `PUT /media` answers `404` as JSON.

Add `test/integration/tags.test.ts`. Its setup runs `createTestApp()` + `tagFixtures(app)`.
- `GET /media`: each entry's `tags` equals `FIXTURE_TAGS` for its name, sorted. Untagged media return `[]`.
- `GET /tags`: the sorted union of the fixture tags.
- `GET /tags/claude`: the count is the number of distinct Media rows among the Claude fixtures (`scene-a` and its copy count once). `GET /tags/series%3Agenshin%20impact` → count 1. `GET /tags/Elf` finds `elf` (normalization). An unknown tag → 404.
- `POST /tags/new-tag` → 201 with `Location`. Repeating it → 200, with the same body and still one row.
- `PUT /tags/sfw` with `{ name: "safe" }` → renamed, and the media keep it. `PUT /tags/nsfw` with `{ name: "elf" }` → merged: `image-variant-2` has `elf` once, and `nsfw` is gone. Unknown tag → 404, missing body name → 400.
- `DELETE /tags/broken` → 204. `not-an-image.png` loses the tag, and `GET /tags/broken` → 404.
- `PUT /media/:id`: replaces the tags (adds, removes, creates new tags), and `[]` clears them. These get a 400: no `tags`, `tags=notjson`, `tags={}`, `tags=[1]`, `tags=[" "]`, `tags[]=a`. Unknown id → 404, `abc` → 400. Unmounted media can be tagged. Duplicates and differently cased forms of a tag (`["Elf","elf "]`) collapse to one.

## Out of scope

Searching media by tag, which is the next spec. Tag domains or namespaces as structured data: `series:` and `meta:` stay plain parts of the string. Deleting tags that no longer have any media.
