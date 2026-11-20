In general, the API deals with standard UTF-8 JSON. POST requests and 200 OK responses are generally going to be a JSON 'Object' with variable names as keys and values obviously as values. There are examples throughout this document. For GET requests, everything is in standard GET parameters, but some variables are complicated and will need to be JSON-encoded and then URL-encoded. An example would be the 'tags' parameter on `GET /get_files/search_files`, which is a list of strings. Since GET http URLs have limits on what characters are allowed, but hydrus tags can have all sorts of characters, you'll be doing this:

#### Your list of tags:

`[ 'character:space bounty hunter', 'creator:青い桜', 'system:height > 2000' ]`
    
#### JSON-encoded:

`["character:space bounty hunter", "creator:\\u9752\\u3044\\u685c", "system:height > 2000"]`
    
#### Then URL-encoded:

`%5B%22character%3Aspace%20bounty%20hunter%22%2C%20%22creator%3A%5Cu9752%5Cu3044%5Cu685c%22%2C%20%22system%3Aheight%20%3E%202000%22%5D`

#### Full URL path example:
    
`/get_files/search_files?file_sort_type=6&file_sort_asc=false&tags=%5B%22character%3Aspace%20bounty%20hunter%22%2C%20%22creator%3A%5Cu9752%5Cu3044%5Cu685c%22%2C%20%22system%3Aheight%20%3E%202000%22%5D`

The API returns JSON for everything except actual file/thumbnail requests. **Every JSON response includes the `version` of the Client API and `hydrus_version` of the Client hosting it (for brevity, these values are not included in the example responses in this help).** For errors, you'll typically get 400 for a missing/invalid parameter, 401/403/419 for missing/insufficient/expired access, and 500 for a real deal serverside error.

