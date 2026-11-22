# Implementation Plan: Tag Search

Implements `specs/09-tags/spec_tag-search.md`. (The original tags plan is in `implementation.md`, in this same directory.)

## Decisions

| Topic | Decision |
| --- | --- |
| Scope | `GET /media` filters **mounted** media only, as it does now. `/media/unmounted` and `/media/:id` don't change. |
| No parameters | The query is the same as today, plus `ORDER BY Media.id`. Today's order is effectively rowid order already; the `ORDER BY` makes it a guarantee. |
| Combining filters | Every parameter that's given must match (AND). |
| Unknown parameters | `400`, naming the parameter. That way a typo like `?extention=jpg` can't quietly return everything. Allowed: `name`, `extension`, `is_video`, `hash`, `tags`, `count`. |
| `count` | Optional. It caps how many results come back, as a `LIMIT ?` applied after `ORDER BY Media.id`, so you get the lowest ids first. It must be a positive integer written in plain digits (`/^[1-9]\d*$/`), at most `Number.MAX_SAFE_INTEGER`. Anything else (`0`, `-1`, `1.5`, `abc`) gets `400`. Left out, there's no limit. There's no offset yet; paging properly is a later spec. |
| Parameter shape | Each parameter must be one non-empty string. A repeated parameter (`?extension=jpg&extension=png`) or the qs array/object form (`?name[]=x`) gets `400`. The app's `extended` query parser turns those forms into arrays or objects, which makes them easy to detect. |
| `name` | Case-insensitive **substring** match on the representative file's `Local.name`, written as `LIKE '%' \|\| ? \|\| '%' ESCAPE '\'`. `%`, `_` and `\` in the input are escaped. Limitation: SQLite's `LIKE` only folds case for ASCII letters. |
| `extension` | Lowercased, then checked against `supportedFileTypes` (exported from `service/localFileService.ts`). Anything else gets `400`. It matches `Local.extension` exactly, except that **`jpg` and `jpeg` are the same**: either one matches `Local.extension IN ('jpg', 'jpeg')`. The parser expands the extension into a list of the names it stands for, using an `EXTENSION_ALIASES` map. Stored extensions don't change; making them all the same in the database is a later, deeper change. |
| `is_video` | Only `true` or `false` are accepted; anything else gets `400`. `false` returns the mounted images. |
| `hash` | Accepts either `sha256:<64 hex>` or bare `<64 hex>`, case-insensitive. It's normalized to the stored `sha256:<lowercase hex>` form. Anything else gets `400`. |
| `hash` response | Always an array, like every other filter. If **no mounted** Media row has the hash, the response is `404`, and that includes a hash that's only on an unmounted row. If the hash exists but another filter rules it out, the response is `[]`. |
| `tags` format | A JSON-URL-encoded array. The top level is **AND**. Each item is either a string or a **one-level** array of strings, which is an **OR** group. Any string, in either place, can start with `-` to negate it. So `['a', ['b', '-c']]` means `a AND (b OR NOT c)`. |
| `tags` parsing | For each string: trim it. A leading `-` means it's negated; remove that one `-`. Then run it through `normalizeTag`. A term that's empty after this (`"-"`, `"- "`) gets `400`. So does a term that still starts with `-` (`"--x"`), because no stored tag can match it. |
| `tags`: malformed (`400`) | The value isn't valid JSON. The top level isn't an array. An item isn't a string or an array. An OR group is empty, or holds a non-string or a nested array. A term is invalid as described above. Also, more than **100** terms in total. That cap keeps SQL parameter counts small, and it's easy to raise. |
| `tags`: edge cases | `[]` adds no tag filter, so it acts as if `tags` were left out. A positive term for a tag that doesn't exist matches nothing, so with AND the response is `[]`. A negated term for a tag that doesn't exist excludes nothing. A query with only negated terms (`['-x']`) returns every mounted node that doesn't have `x`. |
| Tag SQL | Each term becomes `EXISTS (…)` or `NOT EXISTS (…)` over `Media_Tags JOIN Tags WHERE mediaID = Media.id AND Tags.name = ?`. Terms in a group are joined with `OR`, and groups with `AND`. It's easy to check by reading, and it handles negated terms inside OR groups with no special cases. Performance is fine at this scale, because the `Media_Tags` primary key covers `(mediaID, tagID)` and `Tags.name` is UNIQUE (and so indexed). |
| No leading `-` in new tags | Covered by a new `assertAllowedTagName(name)` in `tagService`, which runs **after** normalization, so `" -x"` is caught too. It's called wherever a tag name can be **created**: `POST /tags/:tagName`, the **new** name in `PUT /tags/:tagName`, and `PUT /media/:id` (`setMediaTags`). |
| Lookups with `-` | `GET`, `DELETE` and the old name in `PUT /tags/-x` aren't checked. They give `404` as usual, because no such tag can exist. `normalizeTag` itself doesn't change. |

### Notes on the spec

1. **`PUT /media/:id` creates tags too.** The spec only mentions the `POST`/`PUT /tags` routes, but `PUT /media/:id?tags=["-x"]` would create a tag named `-x` on the fly. You confirmed this was an oversight, so the restriction goes on all three creation paths.
2. **"`/tag` routes".** The routes are mounted at `/tags`, and the writes are `POST /tags/:tagName` and `PUT /tags/:tagName`. This is only a naming slip in the spec.
3. **A hash search that "returns the media node".** Resolved above: the response is an array, so `/media` always has one response shape.
4. **`jpg` and `jpeg`.** They're treated as the same in search only. The stored extensions stay as they appear in the filename, so responses still show `jpg` or `jpeg` for each file.
5. **Pagination.** `count` gives a simple limit. An offset or cursor is left for a later spec.

---

## Step 1: Disallow new tags that start with `-`. Files: `service/tagService.ts`, `test/integration/tags.test.ts`

```ts
/* A tag a client may create. `-` is reserved for negation in GET /media?tags=. Call on a normalized name. */
const assertAllowedTagName = (name: string): void => {
    if (name.startsWith('-')) {
        throw createError(400, `A tag can't start with "-": ${name}`);
    }
}
```

- `createTag`: call it after `normalizeTag(rawName)`.
- `renameOrMergeTag`: call it on `newName` only.
- `setMediaTags`: call it on every normalized name, before the transaction starts.
- Tests: these get `400`: `POST /tags/-x`, `POST /tags/%20-x`, `PUT /tags/elf` with `{ name: "-elf" }`, and `PUT /media/:id?tags=["ok","-x"]`. Check that the last one leaves the media's existing tags unchanged. `POST /tags/x-y` still gives `201`. `GET /tags/-x` gives `404`.

## Step 2: Parse the search query. Files: `util/queryParams.ts`, new `test/unit/queryParams.test.ts`

New types, either in `entity/mediaSearch.ts` or next to the parser:

```ts
type TagTerm = { name: string, negated: boolean };
type TagQuery = TagTerm[][];               // outer = AND, inner = OR (a bare string becomes a group of one)
type MediaSearch = {
    name?: string,
    extensions?: string[],                  // the extension plus its aliases, e.g. ['jpg', 'jpeg']
    isVideo?: boolean,
    hash?: string,                          // normalized to 'sha256:<lowercase hex>'
    tags?: TagQuery,                        // left out when the array is []
    count?: number,                         // a positive integer; left out means no limit
};
```

- `parseTagQuery(raw: unknown): TagQuery` follows the format and `400` rules in the table above. It uses `normalizeTag` from `tagService`. That import goes from util to service, but the dependency is one-way and simple. Alternatively, move `normalizeTag` into `util/` and re-export it from `tagService`. The subagent should pick one and say which.
- `parseMediaSearch(query: Record<string, unknown>): MediaSearch` rejects unknown keys and keys that aren't a single string, then dispatches each parameter to its parser. Every failure is an `http-errors` `400` with a message that names the parameter.
- Export `supportedFileTypes` from `service/localFileService.ts` for the extension check. Add `EXTENSION_ALIASES: string[][] = [['jpg', 'jpeg']]` next to it. Lowercase the input, check that it's supported, then expand it to its alias group, or to `[ext]` if it has none.
- `count` is parsed with the regex from the decisions table, then `Number(...)`, with the safe-integer check.
- Unit tests cover every row of the `400` list, including `count` values that are `0`, `-1`, `1.5`, `1e3`, `abc` and too large. They also cover the normalization of a valid `hash` and `extension`, `jpg` and `jpeg` each expanding to both names, `png` expanding to `['png']`, a bare string becoming a group of one, and `[]` becoming no tag filter.

## Step 3: Repository, service and route. Files: `repository/media.ts`, `service/mediaService.ts`, `routes/media.ts`

**Repository.** Change `getMedia(db, search: MediaSearch = {})` so that it builds `WHERE` clauses and a params array:

```ts
const where: string[] = ['Media.isMounted = 1'];
const params: unknown[] = [];
if (search.name !== undefined)      { where.push(`Local.name LIKE ? ESCAPE '\\'`); params.push(`%${escapeLike(search.name)}%`); }
if (search.extensions !== undefined) {
    where.push(`Local.extension IN (${search.extensions.map(() => '?').join(', ')})`);
    params.push(...search.extensions);
}
if (search.isVideo !== undefined)   { where.push('Local.is_video = ?'); params.push(search.isVideo ? 1 : 0); }
if (search.hash !== undefined)      { where.push('Media.imageHash = ?'); params.push(search.hash); }
for (const group of search.tags ?? []) {
    where.push('(' + group.map(term => {
        params.push(term.name);
        return `${term.negated ? 'NOT ' : ''}EXISTS (SELECT 1 FROM Media_Tags JOIN Tags ON Tags.id = Media_Tags.tagID
                 WHERE Media_Tags.mediaID = Media.id AND Tags.name = ?)`;
    }).join(' OR ') + ')');
}
// … SELECT as today … WHERE ${where.join(' AND ')} ORDER BY Media.id
// then, if search.count !== undefined: append ' LIMIT ?' and push search.count
```

Only fixed SQL text is interpolated; every value is bound. Check how `is_video` is stored first: it's `BOOL`, written from a JS boolean, which should be `1`/`0`. Confirm that against a real row.

**Service.** Add `searchMediaNodes(db, rawQuery)` (or extend `getMediaNodes`):

1. `const search = parseMediaSearch(rawQuery)`.
2. `const rows = await getMedia(db, search)`.
3. If `search.hash` is set and `rows` is empty, call `getMediaByHash(db, search.hash)`. If that finds no row, or the row isn't mounted, throw a `404` (`No mounted media with hash …`). Otherwise return `[]`.
4. Return `rows.map(toMediaNode)`.

**Route.** `GET /` calls `searchMediaNodes(db, req.query)`. Update the route's comment to list the parameters.

## Step 4: Integration tests. File: `test/integration/mediaSearch.test.ts`

Use the existing helpers (`tagFixtures`, `FIXTURE_TAGS`). Work expected results out from the fixture data, not hardcoded counts, wherever that's practical.

- No parameters: same set as before, ordered by id (acceptance 1).
- `?extension=png`: only png entries. `?extension=PNG` works the same. `?extension=bmp` and `?extension=txt` give `400` (acceptance 2).
- `?extension=jpg` and `?extension=jpeg` return the same set, covering every `.jpg` fixture. The fixtures only have `.jpg` files, so add a `.jpeg` copy of a small fixture (a new image, or a byte-different copy so it gets its own Media row). Then the test really shows that both spellings match both kinds of file. Update `test/fixtures/README.md` and `FIXTURE_TAGS` to match.
- `count`: `?count=2` returns the first two ids of the unfiltered list. `?count=2&tags=["elf"]` returns the first two elves. A `count` bigger than the number of results returns all of them. `?count=0` and `?count=abc` give `400`.
- `?is_video=true` returns only `RsniFBN.mp4`. `?is_video=false` returns everything else. `?is_video=yes` gives `400` (acceptance 3).
- `?hash=<known>`, with and without the `sha256:` prefix and in uppercase, returns a one-item array. A well-formed but unknown hash gives `404`. A hash that's only on an unmounted row gives `404`. `?hash=nothex` gives `400`. A known hash combined with `&is_video=true` (for an image) returns `[]` (acceptance 4).
- `?name=roxa` matches `Roxanne.webp`. `?name=%25` (a literal `%`) doesn't match everything.
- Tags (acceptance 5):
  - `["elf"]` returns the three variants.
  - `["elf","-nsfw"]` returns variant-1 and variant-1-resized.
  - `["animated",["video","series:helltaker"]]` returns the gif and the mp4.
  - `[["sfw","-elf"]]` exercises negation inside an OR group.
  - `["-claude"]` returns everything not tagged `claude`.
  - `["does-not-exist"]` returns `[]`.
  - `["-does-not-exist"]` returns everything.
  - `[]` returns everything.
- Tags that get `400`: `not json`, `{"a":1}`, `[1]`, `[[]]`, `[["a",["b"]]]`, `["-"]`, `["--x"]`, `?tags[]=a`, and more than 100 terms.
- Combined: `?tags=["elf"]&extension=jpg`. Unknown parameter: `?foo=1` gives `400`. Repeated parameter: `?extension=png&extension=jpg` gives `400`.

## Step 5: Docs. File: `README.md`

Add `GET /media` query parameters to the endpoints table and the `/media` section: each parameter (including `count`, and `jpg` matching `jpeg`), the `tags` format with examples (URL-encoded and decoded), and the `400`/`404` behavior. Add a note on `/tags` saying that tag names can't start with `-`.

---

## Execution (subagents)

| # | Task | Agent / model | Effort | Depends on | Why |
| --- | --- | --- | --- | --- | --- |
| 1 | Step 1: the `-` restriction and its tests | general-purpose, **Sonnet** | low | none | A small, well-specified change in one file, with tests that follow existing patterns. |
| 2 | Step 2: query parser, types and unit tests | general-purpose, **Sonnet** | medium | none (runs in parallel with 1) | Pure functions with many edge cases. The table gives the exact rules. |
| 3 | Step 3: repository SQL, service, route | general-purpose, **Opus** | medium | 2 | Builds SQL dynamically and has the hash/404 interplay. Correctness matters more than volume. |
| 4 | Step 4: integration tests | general-purpose, **Sonnet** | medium | 1, 3 | Mostly mechanical against the fixtures, but it has to work out expected sets from `FIXTURE_TAGS`. |
| 5 | Step 5: README | general-purpose, **Haiku** | low | 3 (runs in parallel with 4) | Documentation of decisions that are already made. |
| 6 | Review the whole diff (`/code-review high`) and run `npm test` | main session (**Opus**) | high | 4, 5 | Catches SQL injection or binding mistakes and any gaps against the acceptance criteria before you commit. |

Each subagent prompt should include this file's path and its step number. It should also say to run `npm test` before reporting, and to report anything it chose differently from this plan.
