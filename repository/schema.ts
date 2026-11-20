/* Schema version, stored in PRAGMA user_version. Bump it and add an entry to `migrations` to change the schema. */
const CURRENT_VERSION: number = 4;

/**
 * Migration `v` takes the database from version v - 1 to version v.
 * Every migration after 1 must keep existing data.
 */
const migrations: Record<number, (db) => Promise<void>> = {
    // 0 -> 1: data before this point was rebuilt on every start, so it's safe to throw away
    1: async (db) => {
        await db.run('DROP TABLE IF EXISTS Local');
        await db.run('DROP TABLE IF EXISTS Media');
        await db.run(`CREATE TABLE Local (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT, extension TEXT, is_video BOOL,
            directoryPath TEXT NOT NULL,
            source TEXT NOT NULL UNIQUE,
            imageURL TEXT, previewURL TEXT,
            size INTEGER NOT NULL, mtimeMs INTEGER NOT NULL,
            imageHash TEXT NOT NULL,
            mediaID INTEGER NOT NULL DEFAULT -1)`);
        // Not unique: duplicate files are allowed here and are merged at the Media level
        await db.run('CREATE INDEX idx_local_imageHash ON Local(imageHash)');
        await db.run('CREATE INDEX idx_local_directoryPath ON Local(directoryPath)');
        // imageHash is UNIQUE: one Media row per distinct image, shared by every duplicate file
        await db.run(`CREATE TABLE Media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT, isMounted BOOL, tags TEXT,
            imageHash TEXT NOT NULL UNIQUE,
            sourceID INTEGER,
            mediaCollectionID INTEGER, userDataID INTEGER,
            FOREIGN KEY (mediaCollectionID) REFERENCES Collections_Media(mediaID),
            FOREIGN KEY (userDataID) REFERENCES UserData(rowid))`);
    },
    // 1 -> 2: image dimensions. Existing rows get NULL and are measured on the next sync.
    2: async (db) => {
        await db.run('ALTER TABLE Local ADD COLUMN width INTEGER');
        await db.run('ALTER TABLE Local ADD COLUMN height INTEGER');
    },
    // 2 -> 3: perceptual hashes move off the identity hash into their own column (specs/background-perceptual-hash).
    // Old phash16 values aren't carried over: sharp decodes JPEGs slightly differently from image-hash, so every image
    // is hashed again once by the background job, and old and new hashes are never compared.
    // Identity hashes are switched to sha256 by rekeyLegacyHashes on the next start.
    3: async (db) => {
        await db.run('ALTER TABLE Media ADD COLUMN perceptualHash TEXT');
    },
    // 3 -> 4: tags move from a string column on Media into their own table, linked many-to-many (specs/tags).
    // Media.tags was never written to, so there's nothing to carry over.
    // The foreign keys document the links; PRAGMA foreign_keys is off, so the tag service removes links itself.
    4: async (db) => {
        await db.run(`CREATE TABLE Tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE)`);
        await db.run(`CREATE TABLE Media_Tags (
            mediaID INTEGER NOT NULL REFERENCES Media(id),
            tagID INTEGER NOT NULL REFERENCES Tags(id),
            PRIMARY KEY (mediaID, tagID))`);
        // the primary key covers lookups by mediaID; this covers counts, renames and deletes by tag
        await db.run('CREATE INDEX idx_media_tags_tagID ON Media_Tags(tagID)');
        await db.run('ALTER TABLE Media DROP COLUMN tags');
    },
};

/* Brings the database up to CURRENT_VERSION. Each migration runs in its own transaction. */
const migrate = async (db) => {
    await migrateTo(db, CURRENT_VERSION);
};

/* Brings the database up to `target`. Exported for tests that need a database at an older version. */
const migrateTo = async (db, target: number) => {
    const { user_version } = await db.get('PRAGMA user_version');
    if (user_version > CURRENT_VERSION) {
        throw new Error(`Database schema version ${user_version} is newer than this code supports (${CURRENT_VERSION})`);
    }
    for (let v = user_version + 1; v <= target; v++) {
        console.log(`Migrating database schema to version ${v}`);
        await db.run('BEGIN');
        try {
            await migrations[v](db);
            // pragmas can't take bound parameters; v is a number from this file
            await db.run(`PRAGMA user_version = ${v}`);
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            // don't start the server on a half-migrated schema
            throw err;
        }
    }
};

export { migrate, migrateTo, CURRENT_VERSION };
