# Schemas and Migrations

A primer on the schema/migration approach used in `repository/schema.ts`, written alongside the persistence work (`spec.md`, `implementation.md`).

## The problem migrations solve

A database has two parts:
- **The schema:** the tables, columns, types, indexes and constraints. This is the "shape" of the data.
- **The data:** the rows stored in that shape.

The code makes assumptions about the schema. For example, `syncDirectory` expects `Local` to have `size` and `mtimeMs` columns. Before persistence, that was easy to guarantee: every start dropped the tables and recreated them in exactly the shape the code expected. Old data was thrown away each time, so there was never a mismatch.

Persistence breaks that. The database file now outlives any one version of the code. Say a `width` column is added to `Local` next month. The existing `media.sqlite3` was created without it, and `CREATE TABLE IF NOT EXISTS` won't help, because the table already exists (just in the old shape). There needs to be a way to **change the shape of an existing database without losing its data**. That's a migration.

## The core idea: versioned, ordered steps

A migration is a small script that takes the database from version N to version N+1. All of them are kept in order, and the database records which version it's at. On startup:

1. Read the database's current version.
2. Run every migration above it, in order.
3. Record the new version.

That's what `repository/schema.ts` does:

```ts
const { user_version } = await db.get('PRAGMA user_version');
for (let v = user_version + 1; v <= CURRENT_VERSION; v++) {
    await migrations[v](db);
    await db.run(`PRAGMA user_version = ${v}`);
}
```

This means a database at **any** past version can be brought up to date. A copy at version 1 runs migrations 2, 3 and 4. A copy already at 4 runs nothing. A brand-new empty file starts at 0 and runs them all.

**Where the version lives:** SQLite reserves an integer in the database file's header that it never uses itself: `PRAGMA user_version`. It starts at 0, and applications can use it however they like. Most other databases don't have this, so migration tools there create a small bookkeeping table instead (often called `schema_migrations`), with one row per migration that has run. Same idea, different storage.

## The rules that make it work

**1. Never edit a migration after it has run somewhere.** Once a database has reached version 1, it will never run migration 1 again. If migration 1 is edited to add a column, existing databases never get that column, and they're now different from a fresh one. Every change goes in a new migration. This is the most important rule and the one most often broken early on.

**2. Each migration runs in a transaction.** If migration 2 fails halfway, the `ROLLBACK` leaves the database at version 1, exactly as it was, instead of half-changed. SQLite is good at this: schema changes like `CREATE TABLE` and `ALTER TABLE` can be rolled back. That isn't true everywhere; MySQL, for example, commits schema changes immediately.

**3. Refuse to run on a half-migrated database or one from the future.** That's why `migrate()` re-throws on failure, so the server doesn't start, and why it throws if the database's version is newer than the code knows about. That can happen when an older commit is checked out and run against the current database.

**4. Migrations keep data, except in special cases.** Migration 1 drops both tables, which is only safe because version 0 data was rebuilt on every start anyway. From now on, every migration has to carry tags and future user data forward.

## What future migrations will look like

**An easy one: adding a column.** `localFileNode` has `width` and `height`, but they're always 0 and never stored. To start storing them:

```ts
const CURRENT_VERSION = 2;

const migrations = {
    1: async (db) => { /* unchanged; never edit */ },
    // 1 -> 2: store image dimensions
    2: async (db) => {
        await db.run('ALTER TABLE Local ADD COLUMN width INTEGER');
        await db.run('ALTER TABLE Local ADD COLUMN height INTEGER');
    },
};
```

Existing rows get `NULL` for the new columns, and the code fills them in later.

**A harder one: reshaping data.** Right now `Media.tags` is one `TEXT` column. If tags later move into their own table (a common change once searching by tag is wanted), the migration has to move the data as well as the schema:

```ts
3: async (db) => {
    await db.run(`CREATE TABLE Tag (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`);
    await db.run(`CREATE TABLE Media_Tag (mediaID INTEGER NOT NULL, tagID INTEGER NOT NULL,
                  PRIMARY KEY (mediaID, tagID))`);
    // read each Media.tags string, split it, insert into Tag and Media_Tag
    // ...then remove the old column
},
```

This is where migrations earn their keep: the change and the data conversion run together, once, inside one transaction.

**A SQLite quirk to know about:** `ALTER TABLE` in SQLite is limited. It can add, rename and (in recent versions) drop columns, but it can't change a column's type or add a constraint like `UNIQUE` to an existing table. For those, the standard approach is to create a new table in the right shape, copy the rows over, drop the old table and rename the new one. The SQLite docs walk through this step by step (linked below).

## Things worth knowing beyond what's built here

- **Down migrations.** Many tools let each migration also define a `down` step that undoes it, so a change can be rolled back. This project is forward-only, which is common for small projects: if something goes wrong, restore a backup or write a new migration that fixes it. Down migrations sound safer than they are, because undoing a change that dropped data can't bring the data back.
- **Back up before migrating.** For a personal project, copying `media.sqlite3` before a risky migration is a perfectly good safety net.
- **Migration tools.** The hand-written version here is the core of tools like Knex, Prisma Migrate and Flyway. They add migration files on disk, a CLI, history tracking and down steps. The hand-rolled version is about 30 lines, easy to understand, and enough for one SQLite file. A tool becomes worth it with a second database engine or a team.

## Resources

These were written from memory rather than checked, but they're long-standing pages:

- **SQLite `PRAGMA user_version`:** https://www.sqlite.org/pragma.html#pragma_user_version. Short; this is the version counter used here.
- **SQLite `ALTER TABLE`:** https://www.sqlite.org/lang_altertable.html. Covers what SQLite can and can't change directly, and the step-by-step procedure for the harder changes. Worth reading before writing migration 2.
- **SQLite `AUTOINCREMENT`:** https://www.sqlite.org/autoinc.html. Explains `rowid` and why the tables use `INTEGER PRIMARY KEY AUTOINCREMENT`, so ids are never reused.
- **Martin Fowler, "Evolutionary Database Design":** https://martinfowler.com/articles/evodb.html. The classic article on why schemas should change in small, versioned, scripted steps. Conceptual and tool-agnostic.
- **Book: *Refactoring Databases*** by Scott Ambler and Pramod Sadalage. A catalogue of schema changes (split a column, move data to a new table and so on) and how to do each one safely.
- **The Knex.js migrations docs** (knexjs.org, "Migrations" section). A good look at what a full migration tool for Node adds on top of the approach here, including `up` and `down` steps.
