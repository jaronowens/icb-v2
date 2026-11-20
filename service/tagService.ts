import createError from 'http-errors';
import { TagDetail, TagRef } from '../entity/tag';
import {
    getAllTagNames, getTagByName, countMediaForTag, insertTag, renameTag, deleteTag, moveTagLinks,
    getTagIDsForMedia, linkTag, unlinkTag, TagRow,
} from '../repository/tags';
import { mediaExists } from '../repository/media';
import { withTransaction } from '../util/transaction';

/**
 * The form every tag is stored and looked up in: trimmed, inner whitespace collapsed to one space, lowercased.
 * Throws a 400 for anything that isn't a string, or is empty once normalized.
 */
const normalizeTag = (raw: unknown): string => {
    if (typeof raw !== 'string') {
        throw createError(400, 'A tag must be a string');
    }
    const name = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (name === '') {
        throw createError(400, 'A tag can\'t be empty');
    }
    return name;
}

/* Where a tag can be fetched. Relative, like the routes themselves. */
const tagURL = (name: string): string => `/tags/${encodeURIComponent(name)}`;

const tagRef = (name: string): TagRef => ({ name, url: tagURL(name) });

/* The tag with this (normalized) name, or a 404. */
const findTag = async (db, name: string): Promise<TagRow> => {
    const tag = await getTagByName(db, name);
    if (!tag) {
        throw createError(404, `Tag "${name}" not found`);
    }
    return tag;
}

/* The id of the tag with this (normalized) name, creating the tag if needed. Call inside a transaction. */
const findOrCreateTagID = async (db, name: string): Promise<number> => {
    const tag = await getTagByName(db, name);
    return tag ? tag.id : insertTag(db, name);
}

const listTags = async (db): Promise<string[]> => getAllTagNames(db);

const getTagDetail = async (db, rawName: unknown): Promise<TagDetail> => {
    const tag = await findTag(db, normalizeTag(rawName));
    return { name: tag.name, count: await countMediaForTag(db, tag.id) };
}

/* Adds a tag. An existing tag is left as it is and reported with created: false. */
const createTag = async (db, rawName: unknown): Promise<{ tag: TagRef, created: boolean }> => {
    const name = normalizeTag(rawName);
    return withTransaction(db, async () => {
        // checked inside the lock, so two requests for the same tag can't both insert it
        const created = !(await getTagByName(db, name));
        if (created) {
            await insertTag(db, name);
        }
        return { tag: tagRef(name), created };
    });
}

/**
 * Renames a tag. If another tag already has the new name, the two merge: every Media row linked to the old tag
 * is linked to the existing one instead, and the old tag is deleted. Returns the tag the links end up on.
 */
const renameOrMergeTag = async (db, rawName: unknown, rawNewName: unknown): Promise<TagRef> => {
    const name = normalizeTag(rawName);
    if (rawNewName === undefined) {
        throw createError(400, 'name is required: { "name": "<new name>" }');
    }
    const newName = normalizeTag(rawNewName);
    return withTransaction(db, async () => {
        const tag = await findTag(db, name);
        if (newName !== tag.name) {
            const existing = await getTagByName(db, newName);
            if (existing) {
                await moveTagLinks(db, tag.id, existing.id);
                await deleteTag(db, tag.id);
            } else {
                await renameTag(db, tag.id, newName);
            }
        }
        return tagRef(newName);
    });
}

/* Deletes a tag and unlinks every Media row from it. */
const removeTag = async (db, rawName: unknown): Promise<void> => {
    const name = normalizeTag(rawName);
    await withTransaction(db, async () => {
        const tag = await findTag(db, name);
        await deleteTag(db, tag.id);
    });
}

/**
 * Makes `names` the Media row's complete set of tags: missing tags are created, links not in `names` are removed.
 * Names are normalized and de-duplicated. Throws a 404 if there's no such Media row.
 */
const setMediaTags = async (db, mediaID: number, rawNames: unknown[]): Promise<void> => {
    const names = [...new Set(rawNames.map(normalizeTag))];
    await withTransaction(db, async () => {
        if (!(await mediaExists(db, mediaID))) {
            throw createError(404, `Media ${mediaID} not found`);
        }
        const wanted = new Set<number>();
        for (const name of names) {
            wanted.add(await findOrCreateTagID(db, name));
        }
        const current = new Set(await getTagIDsForMedia(db, mediaID));
        for (const tagID of current) {
            if (!wanted.has(tagID)) {
                await unlinkTag(db, mediaID, tagID);
            }
        }
        for (const tagID of wanted) {
            if (!current.has(tagID)) {
                await linkTag(db, mediaID, tagID);
            }
        }
    });
}

export { normalizeTag, tagURL, listTags, getTagDetail, createTag, renameOrMergeTag, removeTag, setMediaTags };
