import { sha256File, SHA256_PREFIX } from './hashService';

const CONCURRENCY: number = 8;

type LegacyRow = { id: number, source: string, mediaID: number, sha256?: string };

/**
 * One-time upgrade from perceptual identity hashes to sha256 (specs/07-background-perceptual-hash).
 *
 * Gives every Local row that still has a `phash` identity hash its sha256. Each Media row keeps its id (and tags)
 * under the sha256 of its lowest-id file. Files with different bytes (resized copies that used to share the row)
 * are unlinked, so the normal sync steps give them Media rows of their own.
 *
 * Files that can't be read are left as they are: missing files are deleted by the directory sync that follows,
 * and anything else is retried on the next start. Does nothing once no `phash` Local rows remain.
 */
const rekeyLegacyHashes = async (db): Promise<void> => {
    const rows: LegacyRow[] = await db.all(`SELECT id, source, mediaID FROM Local WHERE imageHash LIKE 'phash%' ORDER BY id`);
    if (rows.length === 0) {
        return;
    }
    console.log(`Re-keying ${rows.length} files from perceptual identity hashes to sha256`);

    let unreadable = 0;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
        await Promise.all(rows.slice(i, i + CONCURRENCY).map(async row => {
            try {
                row.sha256 = `${SHA256_PREFIX}${await sha256File(row.source)}`;
            } catch {
                unreadable++;
            }
        }));
    }
    if (unreadable > 0) {
        console.warn(`Could not read ${unreadable} files while re-keying; they're handled by the directory sync`);
    }
    const hashed = rows.filter(row => row.sha256);

    // grouped by Media row, keeping id order, so the lowest-id file decides each row's new key
    const groups = new Map<number, LegacyRow[]>();
    for (const row of hashed) {
        groups.set(row.mediaID, [...(groups.get(row.mediaID) ?? []), row]);
    }

    let rekeyed = 0;
    let splitOff = 0;
    await db.run('BEGIN');
    try {
        for (const [mediaID, group] of groups) {
            const media = mediaID === -1 ? undefined : await db.get('SELECT imageHash FROM Media WHERE id = ?', [mediaID]);
            // The key this Media row ends up with, or undefined if its files can't stay linked to it
            let key: string | undefined;
            if (media && media.imageHash.startsWith('phash')) {
                const candidate = group[0].sha256;
                // only possible if files changed between starts: another row already owns these bytes
                const taken = await db.get('SELECT id FROM Media WHERE imageHash = ? AND id != ?', [candidate, mediaID]);
                if (!taken) {
                    await db.run('UPDATE Media SET imageHash = ? WHERE id = ?', [candidate, mediaID]);
                    key = candidate;
                    rekeyed++;
                }
            } else if (media) {
                // already re-keyed on an earlier start (this file couldn't be read then)
                key = media.imageHash;
            }
            for (const row of group) {
                if (key !== undefined && row.sha256 === key) {
                    await db.run('UPDATE Local SET imageHash = ? WHERE id = ?', [row.sha256, row.id]);
                } else {
                    await db.run('UPDATE Local SET imageHash = ?, mediaID = -1 WHERE id = ?', [row.sha256, row.id]);
                    if (mediaID !== -1) {
                        splitOff++;
                    }
                }
            }
        }
        await db.run('COMMIT');
    } catch (err) {
        await db.run('ROLLBACK');
        throw err;
    }
    console.log(`Re-keyed ${rekeyed} media rows to sha256, split off ${splitOff} files`);
}

export { rekeyLegacyHashes };
