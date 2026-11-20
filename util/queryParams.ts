import createError from 'http-errors';

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

export { parseJsonStringArray };
