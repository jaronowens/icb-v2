# SQL problems found during the image-hash conversion

Each entry shows the original SQL or code, explains what goes wrong, and describes how it was fixed (or why it was left alone). They're roughly ordered by how much they affected the app.

---

## 1. `SELECT *` doesn't return `rowid`

**Where:** `populateMediaFromSource()` in `repository/media.ts`

```ts
const rows = await db.all(`SELECT * FROM ${sourceTable}`);
// ...
row.rowid,   // inserted as Media.sourceID
```

**What's wrong:** In SQLite, every ordinary table has a hidden `rowid` column, but `*` only expands to the columns you declared. `row.rowid` was therefore always `undefined`, which the driver binds as `NULL`. Every `Media.sourceID` was `NULL`, so a Media row could never be traced back to its file.

**Lesson:** If you need `rowid`, ask for it by name: `SELECT rowid, * FROM Local`. Or declare an explicit `id INTEGER PRIMARY KEY`, which becomes an alias for `rowid` and *is* included in `*`.

**Fix:** The new query uses `MIN(rowid)` directly inside an `INSERT ... SELECT` (see #2).

---

## 2. `populateMediaFromSource` inserts every row, not just unlinked ones

**Where:** `populateMediaFromSource()`

```ts
const rows = await db.all(`SELECT * FROM ${sourceTable}`);
// const rows = await db.all(`SELECT ${tableName}.rowid, * from ${sourceTable} LEFT JOIN ${tableName} ON ...`);
```

**What's wrong:** The log message says "trying to find unlinked local nodes", but the query selects *all* of them. The commented-out LEFT JOIN was half of an **anti-join**, the standard "rows in A with no match in B" pattern. It was missing the `WHERE` clause that makes it work:

```sql
SELECT Local.* FROM Local
LEFT JOIN Media ON Media.imageURL = Local.imageURL
WHERE Media.rowid IS NULL;      -- <- the part that keeps only unmatched rows
```

While the tables are dropped on every start you don't notice. Once data persists, every restart would add another copy of every Media row.

**Fix:** This is now a single `INSERT ... SELECT` that only adds hashes Media doesn't have yet:

```sql
INSERT INTO Media (type, isMounted, tags, imageURL, imageHash, sourceID, mediaCollectionID, userDataID)
SELECT ?, 1, NULL, imageURL, imageHash, MIN(rowid), NULL, NULL
FROM Local
WHERE imageHash NOT IN (SELECT imageHash FROM Media)
GROUP BY imageHash;
```

Two things to notice:
- **`GROUP BY imageHash`** merges duplicate files into one Media row. `imageURL` isn't aggregated (it's a "bare column"). Most databases reject that, but SQLite allows it, and when the query uses `MIN()` or `MAX()`, SQLite promises that bare columns come from the row that won. So `imageURL` belongs to the same file as `MIN(rowid)`.
- **`NOT IN` and `NULL` trap:** if the subquery ever returned a `NULL`, `x NOT IN (..., NULL)` evaluates to `NULL` (not true) for **every** row, and nothing would be inserted. That's safe here only because `Media.imageHash` is `NOT NULL`. `WHERE NOT EXISTS (SELECT 1 FROM Media WHERE Media.imageHash = Local.imageHash)` avoids the trap completely, and is a good habit.

---

## 3. One giant bulk `INSERT` with N×7 placeholders

**Where:** `insertLocalNodes()` and `populateMediaFromSource()`

```ts
const placeholders = localNodes.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
```

(About the comment in the old code, "what is the point of mapping a string with no variables?": `map` is used here to produce *one copy of the string per row*. `'(?, ...)'.repeat(n)` wouldn't put in the `, ` separators, and `Array(n).fill('(...)').join(', ')` would do the same thing. Your instinct was right that only the length matters.)

**What's wrong:**
- SQLite caps the number of `?` parameters in one statement (`SQLITE_MAX_VARIABLE_NUMBER`, 32766 in current builds, and as low as 999 in older ones). With 7–8 columns per row, a directory with a few thousand files goes over the cap, and the **whole insert fails**. The error is only logged, so the app starts with an empty table.
- One bad row (for example, a duplicate `imageURL`, which breaks the `UNIQUE` constraint) also fails the entire statement.

**Fix:** `insertLocalNodes` now inserts 500 rows per statement, inside `BEGIN` / `COMMIT`, with a `ROLLBACK` on error. That keeps it all-or-nothing, and also faster: SQLite commits each statement separately unless you wrap them in a transaction. `populateMediaFromSource` no longer binds per-row values at all (#2).

---

## 4. A scalar subquery with no match sets `mediaID` to `NULL`

**Where:** `syncUnlinkedLocalNodes()`

```sql
UPDATE Local
SET mediaID = (SELECT Media.rowid FROM Media WHERE Media.imageURL = Local.imageURL)
WHERE Local.mediaID = -1;
```

**What's wrong:**
- A scalar subquery that finds no rows evaluates to `NULL`. Every unlinked Local row with no matching Media got `mediaID = NULL`, which wiped out the `-1` "unlinked" marker. The next run's `WHERE mediaID = -1` would then never see those rows again.
- If the subquery matches **more than one** row, SQLite quietly uses the first one, so duplicates were linked arbitrarily.
- The function was never exported or called, so in practice every `Local.mediaID` stayed `-1`.

**Fix:** Only update rows that have a match, and match on a column that is `UNIQUE` in Media:

```sql
UPDATE Local
SET mediaID = (SELECT Media.rowid FROM Media WHERE Media.imageHash = Local.imageHash)
WHERE Local.mediaID = -1
  AND EXISTS (SELECT 1 FROM Media WHERE Media.imageHash = Local.imageHash);
```

It's exported now and runs at startup.

---

## 5. `LEFT JOIN ... WHERE right.col IS NOT NULL` is really an inner join

**Where:** `synchronizeMedia()`

```sql
WHERE rowid IN (
    SELECT Media.rowid FROM Media
    LEFT JOIN Local ON Media.imageURL = Local.imageURL
    WHERE Media.isMounted = 0 AND Local.imageURL IS NOT NULL
);
```

**What's wrong:** It's not *incorrect*. But a LEFT JOIN exists to *keep* rows with no match, and `Local.imageURL IS NOT NULL` then throws exactly those rows away. The result is an `INNER JOIN` written in a more confusing way. The `IN (subquery)` around it is also unnecessary.

**Fix:** Say what you mean with `EXISTS`:

```sql
UPDATE Media SET isMounted = 1
WHERE isMounted = 0
  AND EXISTS (SELECT 1 FROM Local WHERE Local.imageHash = Media.imageHash);
```

---

## 6. `SELECT Media.rowid, *` over a join

**Where:** `getMedia()`

```sql
SELECT Media.rowid, * from Local LEFT JOIN Media ON Local.imageURL = Media.imageURL
```

**What's wrong:**
- `*` over a join returns **both** tables' columns. Both have `imageURL`, so each result object has two `imageURL` keys, and the driver keeps whichever comes last. Today they're equal because they're the join key, but that's luck, not design.
- The result key for `Media.rowid` is just `rowid`, which is easy to confuse with Local's rowid. For Local rows with no matching Media, it's `NULL`, so the API returned `id: null`.
- It joins on the URL even though `Local.mediaID` is a real foreign key meant for exactly this join.

**Fix:** List the columns explicitly, alias the id, and join on the key:

```sql
SELECT Media.rowid AS id, Media.imageHash, Media.tags,
       Local.name, Local.extension, Local.is_video, Local.imageURL, Local.previewURL, Local.source
FROM Media
JOIN Local ON Local.rowid = Media.sourceID;
```

---

## 7. Foreign keys pointing at tables that don't exist (and in the wrong direction)

**Where:** `initializeMediaDB()`

```sql
FOREIGN KEY (mediaCollectionID) REFERENCES Collections_Media(mediaID),
FOREIGN KEY (userDataID)        REFERENCES UserData(rowid)
```

**What's wrong:**
- Neither `Collections_Media` nor `UserData` exists. SQLite accepts this anyway because **foreign keys aren't enforced unless you run `PRAGMA foreign_keys = ON`** on each connection. Turn that on and every Media insert fails.
- `Collections_Media` sounds like a join table between Collections and Media. In a many-to-many relationship, the join table holds the foreign keys (`Collections_Media.mediaID REFERENCES Media(rowid)`), not the Media table. As written, each Media row could belong to only one collection.
- Referencing `rowid` in a foreign key is fragile. `rowid` values can change on `VACUUM` unless the table declares an `INTEGER PRIMARY KEY`.

**Status:** Left unchanged, because collections and user data are out of scope. It's worth fixing when those tables are designed.

---

## 8. Table names interpolated into SQL

**Where:** `populateMediaFromSource(sourceTable)` and the old `getMedia(db, sourceTable)`

```ts
db.all(`SELECT * FROM ${sourceTable}`)
```

**What's wrong:** Values can be bound with `?`, but **identifiers** (table and column names) can't. Interpolating them is fine while the argument is hard-coded, but becomes SQL injection the moment it comes from a request.

**Fix:** `populateMediaFromSource` checks `sourceTable` against an allow-list (`['Local']`) before building the query. `getMedia` no longer takes the parameter.

---

## 9. Startup race in `app.js` (async, not SQL, but it made the SQL look broken)

```js
await initializeMediaDB(db, true).then(() => {
    for (const directory of directories) {
        createLocalNodes(...);          // not awaited
    }
}).then(() => {
    synchronizeMedia(db, true);         // not returned, so not awaited
});
await populateMediaFromSource('Local', db);
```

**What's wrong:** The `createLocalNodes` promises were started and then ignored. So `populateMediaFromSource` could run while the inserts were still in progress, and `synchronizeMedia` ran *before* any Media rows existed. With hashing (which takes seconds to minutes), `populateMediaFromSource` would reliably see an empty `Local` table.

**Fix:** A straight sequence of `await`s: create tables → insert each directory → populate Media → link Local → mark mounted.

---

## 10. Schema and entity drift

- `localFileNode` has `width` and `height`, but the `Local` table has no such columns, so they're silently dropped. `MediaNode` always reports `0`.
- `is_video BOOL`: SQLite has no boolean type. `BOOL` gets NUMERIC affinity and `true`/`false` are stored as `1`/`0`, which is why the API returns `"is_video": 0` instead of `false`. Convert it in the service layer if the front end expects a real boolean.

**Status:** Noted, not changed (out of scope).
