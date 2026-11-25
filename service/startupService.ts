import * as fs from 'node:fs';
import { migrate } from '../repository/schema';
import { deleteLocalNodesOutsideDirectories } from '../repository/local';
import { populateMediaFromSource, syncUnlinkedLocalNodes, refreshMediaSources, synchronizeMedia } from '../repository/media';
import { syncDirectory } from './localFileService';
import { rekeyLegacyHashes } from './rekeyService';

type Directory = { name: string, path: string };

// Directory names become route paths (/<name>/<file>). Express 5 rejects reserved characters
// in paths, so only allow names that are always safe.
const VALID_DIRECTORY_NAME = /^[A-Za-z0-9_-]+$/;

// 'thumbnails' is reserved: /thumbnails serves the thumbnail cache (specs/10-thumbnails), so a directory can't take that path.
const RESERVED_DIRECTORY_NAMES = ['thumbnails'];

const isValidDirectoryName = (name: string): boolean => VALID_DIRECTORY_NAME.test(name) && !RESERVED_DIRECTORY_NAMES.includes(name);

/**
 * Brings the database up to date with the directories on disk: migrates the schema, syncs each directory,
 * then creates, links, re-points and mounts Media rows. Resolves once the database is ready, rejects if startup fails.
 *
 * `db` may be an open connection or the promise for one.
 */
const startup = async (db, directories: Directory[]): Promise<void> => {
    const connection = await db;
    await migrate(connection);
    // Each step depends on the previous one finishing, so everything is awaited in order:
    // the one-time sha256 re-key, then all Local changes, then Media rows for new hashes, linking, re-pointing sources, and mounting last.
    await rekeyLegacyHashes(connection);
    for (const directory of directories.filter(directory => isValidDirectoryName(directory.name))) {
        try {
            await syncDirectory(directory.name, directory.path, connection, fs);
        }
        catch (err) {
            console.error(`Failed to sync ${directory.path}:`, err.message);
        }
    }
    // Directories that couldn't be read or have an invalid name are still in directories.json, so their rows are kept
    await deleteLocalNodesOutsideDirectories(connection, directories.map(directory => directory.path));
    await populateMediaFromSource('Local', connection);
    await syncUnlinkedLocalNodes(connection);
    await refreshMediaSources(connection);
    await synchronizeMedia(connection, true);
    console.log('Database ready');
}

export { startup, isValidDirectoryName, Directory };
