### files
If you need to refer to some files, you can use any of the following:

Arguments:

- `file_id`: (selective, a numerical file id)
- `file_ids`: (selective, a list of numerical file ids)
- `hash`: (selective, a hexadecimal SHA256 hash)
- `hashes`: (selective, a list of hexadecimal SHA256 hashes)

In GET requests, make sure any list is percent-encoded JSON. Your `[1,2,3]` becomes `file_ids=%5B1%2C%202%2C%203%5D`.
### file domain

When you are searching, you may want to specify a particular file domain. Most of the time, you'll want to just set `file_service_key`, but this can get complex:

Arguments:

- `file_service_key`: (optional, selective A, hexadecimal, the file domain on which to search)
- `file_service_keys`: (optional, selective A, list of hexadecimals, the union of file domains on which to search)
- `deleted_file_service_key`: (optional, selective B, hexadecimal, the 'deleted from this file domain' on which to search)
- `deleted_file_service_keys`: (optional, selective B, list of hexadecimals, the union of 'deleted from this file domain' on which to search)

The service keys are as in `/get_services`.