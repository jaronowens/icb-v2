The client gives access to its API through different 'access keys', which are the typical random 64-character hex used in many other places across hydrus. Each guarantees different permissions such as handling files or tags. Most of the time, a user will provide full access, but do not assume this. If a access key header or parameter is not provided, you will get 401, and all insufficient permission problems will return 403 with appropriate error text.

Access is required for every request. You can provide this as an http header, like so:

`Hydrus-Client-API-Access-Key : 0150d9c4f6a6d2082534a997f4588dcf0c56dffe1d03ffbf98472236112236ae`

### Requesting an access key
You can get an access key by one of two ways: getting it manually from `review services > client api > add` in the Hydrus Client, or programmatically via a request to the `/request_new_permissions` endpoint. This endpoints accepts a `name` argument, which is a descriptive name of your access, and a `permit_everything` boolean flag that permits all tasks now and in future, or a `basic_permissions` JSON-encoded list of numerical permission identifiers.

**Example**:
```/request_new_permissions?name=migrator&permit_everything=true```

This request requires the 'add from api request' mini-dialog in the client to be open, otherwise it will 403.

**Response**:
Some JSON with your access key, which is 64 characters of hex. This will not be valid until the user approves the request in the client ui.

**Example response:**
`{ "access_key" : "73c9ab12751dcf3368f028d3abbe1d8e2a3a48d0de25e64f3a8f00f3a1424c57" }`
