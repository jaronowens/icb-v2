Now that tags are supported, the next step is to allow API support for searching Media nodes by query parameter.

## Spec

The current `/media` route returns a list of all mounted media nodes that are currently in the database. This needs to be modified to optionally accept query parameters that filter results that match the query.

### Searchable fields:

- name (string)
- extension (string)
- is_video (boolean)
- hash (assume a hash provided via this query parameter is SHA256)
- tags
    - `tags` accepts a URL-encoded JSON array of strings, and returns any Media node that matches all tags specified in the array.
    - `tags` also accepts nested arrays, which specifies OR. For example, `['1girl', ['akali', 'miss fortune']]` should return all media nodes tagged '1girl', and either 'akali' or 'miss fortune'.
    - A tag in the request array with a `-` in front of it should be *excluded* from search results. For example, `['1girl', '-miss fortune']` should return all media nodes tagged '1girl' except ones that also have the 'miss fortune' tag.

### Modifications to `/tag` routes

In order to support the negation requirement, the `POST` and `PUT` routes on `/tags` should be modified so that they do not accept tags that start with `-`. This can be changed without worrying about pre-existing data, as no tags have been added to the database that violate this.

### Acceptance

1. Making a request of `/media` with no query parameters should return the same result as before (all mounted media nodes).
2. Specifying a file extension should return all nodes of that file extension. An invalid file extension, or one that the server doesn't support, returns `400`.
3. Specifying `is_video=true` should return all mounted videos.
4. Searching for a specific SHA256 hash returns the media node it's associated with, or `404` if it's not found.
5. Searching for tags follows the structure outlined in the spec.
    - If no media is found that matches the tags, return an empty array.
    - Malformed tag arrays get `400`.