import createError from 'http-errors';
import { TagTerm, TagQuery, MediaSearch } from '../entity/mediaSearch';
import { normalizeTag } from '../service/tagService';
import { supportedFileTypes, EXTENSION_ALIASES } from '../service/localFileService';

/**
 * Parses a query parameter holding a JSON-URL-encoded array of strings, the scheme the Hydrus Client API uses
 * (specs/08-hydrus-research/API/General Information.md). Express has already URL-decoded the value, so this only
 * parses the JSON. Throws a 400 if the parameter is missing, isn't a single string, or isn't a JSON string array.
 */
const parseJsonStringArray = (raw: unknown, name: string): string[] => {
    if (raw === undefined) {
        throw createError(400, `${name} is required: a JSON-URL-encoded array of strings`);
    }
    // the extended query parser turns ?name[]=a or ?name=a&name=b into arrays or objects
    if (typeof raw !== 'string') {
        throw createError(400, `${name} must be a single JSON-URL-encoded array of strings`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw createError(400, `${name} is not valid JSON`);
    }
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
        throw createError(400, `${name} must be a JSON array of strings`);
    }
    return parsed;
}

const MAX_TAG_TERMS = 100;
const SEARCH_PARAMS = ['name', 'extension', 'is_video', 'hash', 'tags', 'count'];

/**
 * Parses one tag term: trimmed, a leading `-` means negated, the rest is normalized like a stored tag name.
 * Throws a 400 if nothing is left, or if it still starts with `-` (no stored tag can).
 */
const parseTagTerm = (raw: unknown): TagTerm => {
    if (typeof raw !== 'string') {
        throw createError(400, 'tags: each term must be a string');
    }
    const trimmed = raw.trim();
    const negated = trimmed.startsWith('-');
    let name: string;
    try {
        name = normalizeTag(negated ? trimmed.slice(1) : trimmed);
    } catch {
        throw createError(400, `tags: invalid term ${JSON.stringify(raw)}`);
    }
    if (name.startsWith('-')) {
        throw createError(400, `tags: a term can't start with "-" after the negation: ${JSON.stringify(raw)}`);
    }
    return { name, negated };
}

/**
 * Parses the tags parameter: a JSON array that is the AND of its items, each a string or a one-level array of strings
 * (an OR group). Any string can start with `-` to negate it. `[]` gives an empty query. Throws a 400 if it's malformed
 * or has more than 100 terms.
 */
const parseTagQuery = (raw: unknown): TagQuery => {
    if (typeof raw !== 'string') {
        throw createError(400, 'tags must be a single JSON-URL-encoded array');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw createError(400, 'tags is not valid JSON');
    }
    if (!Array.isArray(parsed)) {
        throw createError(400, 'tags must be a JSON array');
    }
    let termCount = 0;
    const query: TagQuery = parsed.map(item => {
        let terms: unknown[];
        if (Array.isArray(item)) {
            if (item.length === 0) {
                throw createError(400, 'tags: an OR group can\'t be empty');
            }
            terms = item;
        } else if (typeof item === 'string') {
            terms = [item];
        } else {
            throw createError(400, 'tags: each item must be a string or an array of strings');
        }
        termCount += terms.length;
        if (termCount > MAX_TAG_TERMS) {
            throw createError(400, `tags: at most ${MAX_TAG_TERMS} terms are allowed`);
        }
        return terms.map(parseTagTerm);
    });
    return query;
}

const parseExtension = (raw: string): string[] => {
    const extension = raw.toLowerCase();
    if (!supportedFileTypes.includes(extension)) {
        throw createError(400, `extension must be one of: ${supportedFileTypes.join(', ')}`);
    }
    return EXTENSION_ALIASES.find(group => group.includes(extension)) ?? [extension];
}

const parseIsVideo = (raw: string): boolean => {
    if (raw !== 'true' && raw !== 'false') {
        throw createError(400, 'is_video must be true or false');
    }
    return raw === 'true';
}

const parseHash = (raw: string): string => {
    const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(raw);
    if (!match) {
        throw createError(400, 'hash must be sha256:<64 hex digits> or 64 hex digits');
    }
    return `sha256:${match[1].toLowerCase()}`;
}

const parseCount = (raw: string): number => {
    const count = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(count)) {
        throw createError(400, 'count must be a positive integer');
    }
    return count;
}

/**
 * Parses the GET /media query parameters (specs/09-tags). Every parameter given must be one non-empty string, and
 * unknown parameters are rejected so a typo can't quietly return everything. Throws a 400 naming the parameter.
 */
const parseMediaSearch = (query: Record<string, unknown>): MediaSearch => {
    for (const key of Object.keys(query)) {
        if (!SEARCH_PARAMS.includes(key)) {
            throw createError(400, `Unknown parameter: ${key}. Allowed: ${SEARCH_PARAMS.join(', ')}`);
        }
        // the extended query parser turns ?name[]=a or ?name=a&name=b into arrays or objects
        if (typeof query[key] !== 'string' || query[key] === '') {
            throw createError(400, `${key} must be a single non-empty string`);
        }
    }
    const search: MediaSearch = {};
    if (query.name !== undefined) {
        search.name = query.name as string;
    }
    if (query.extension !== undefined) {
        search.extensions = parseExtension(query.extension as string);
    }
    if (query.is_video !== undefined) {
        search.isVideo = parseIsVideo(query.is_video as string);
    }
    if (query.hash !== undefined) {
        search.hash = parseHash(query.hash as string);
    }
    if (query.tags !== undefined) {
        const tags = parseTagQuery(query.tags);
        if (tags.length > 0) {
            search.tags = tags;
        }
    }
    if (query.count !== undefined) {
        search.count = parseCount(query.count as string);
    }
    return search;
}

export { parseJsonStringArray, parseTagQuery, parseMediaSearch };
