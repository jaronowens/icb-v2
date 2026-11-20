File search in hydrus is not paginated like a booru--all searches return all results in one go. In order to keep this fast, search is split into two steps--fetching file identifiers with a search, and then fetching file metadata in batches.
### GET `/get_files/search_files`

_Search for the client's files._

Restricted access:

YES. Search for Files permission needed. Additional search permission limits may apply.

Required Headers: n/a

Arguments (in percent-encoded JSON):

- `tags`: (a list of tags you wish to search for)
- [file domain](./Files.md) (optional, defaults to _combined local file domains_)
- `tag_service_key`: (optional, hexadecimal, the tag domain on which to search, defaults to _combined local file domains_)
- `include_current_tags`: (optional, bool, whether to search 'current' tags, defaults to `true`)
- `include_pending_tags`: (optional, bool, whether to search 'pending' tags, defaults to `true`)
- `file_sort_type`: (optional, integer, the results sort method, defaults to `2` for `import time`)
- `file_sort_asc`: true or false (optional, default `true`, the results sort order)
- `return_file_ids`: true or false (optional, default `true`, returns file id results)
- `return_hashes`: true or false (optional, default `false`, returns hex hash results)

### **GET `/get_files/file_hashes`**

_Lookup file hashes from other hashes._

Restricted access:

YES. Search for Files permission needed.

Required Headers: n/a

Arguments (in percent-encoded JSON):

- `hash`: (selective, a hexadecimal hash)
- `hashes`: (selective, a list of hexadecimal hashes)
- `source_hash_type`: [sha256|md5|sha1|sha512] (optional, defaulting to sha256)
- `desired_hash_type`: [sha256|md5|sha1|sha512]

### **GET `/get_files/file_metadata`**

_Get metadata about files in the client._

Restricted access:

YES. Search for Files permission needed. Additional search permission limits may apply.

Required Headers: n/a

Arguments (in percent-encoded JSON):

- [files](./Files.md)
- `create_new_file_ids`: true or false (optional if asking with hash(es), defaulting to false)
- `only_return_identifiers`: true or false (optional, defaulting to false)
- `only_return_basic_information`: true or false (optional, defaulting to false)
- `detailed_url_information`: true or false (optional, defaulting to false)
- `include_blurhash`: true or false (optional, defaulting to false. Only applies when `only_return_basic_information` is true)
- `include_milliseconds`: true or false (optional, defaulting to false)
- `include_notes`: true or false (optional, defaulting to false)
- `include_services_object`: true or false (optional, defaulting to true)
- `hide_service_keys_tags`: **Deprecated, will be deleted soon!** true or false (optional, defaulting to true)