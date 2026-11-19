Hydrus manages its different available domains and actions with what it calls _services_. The Client API needs to refer to services, either to accept commands from you or to tell you what metadata files have and where.

When the client tells you about the available services, it gives you the following structure, typically under a `services_v2` key right off the root node.

`[ { "name" : "my tags", "service_key" : "c6f63616c2074616773", "type": 5, "type_pretty" : "local tag domain" }, { "name" : "example tag repo", "service_key" : "5674450950748cfb28778b511024cfbf0f9f67355cf833de632244078b5a6f8d", "type" : 0, "type_pretty" : "hydrus tag repository" }, { "name" : "my files", "service_key" : "6c6f63616c2066696c6573", "type" : 2, "type_pretty" : "local file domain" }, { "name" : "repository updates", "service_key" : "7265706f7369746f72792075706461746573", "type" : 20, "type_pretty" : "local update file domain" } ]`

All services have these properties:

- `name` - A mutable human-friendly name like 'my tags'. You can use this to present the service to the user--they should recognize it.
- `type` - An integer enum saying whether the service is a local tag domain or like/dislike rating or whatever. This cannot change.
- `service_key` - The true 'id' of the service. It is a string of hex, sometimes just twenty or so characters but in many cases sixty-four characters. This cannot change, and it is how we will refer to different services.

You won't see all of these, but the service `type` enum is:
- 0 - tag repository
- 1 - file repository
- 2 - a local file domain like 'my files'
- 5 - a local tag domain like 'my tags'
- 6 - a 'numerical' rating service with several stars
- 7 - a 'like/dislike' rating service with on/off status
- 10 - all known tags -- a union of all the tag services
- 11 - all known files -- a union of all the file services and files that appear in tag services
- 12 - the local booru -- you can ignore this
- 13 - IPFS
- 14 - trash
- 15 - hydrus local file storage -- all files on hard disk ('combined local file domains' + updates + trash)
- 17 - file notes
- 18 - Client API
- 19 - deleted from anywhere -- you can ignore this
- 20 - local updates -- a file domain to store repository update files in
- 21 - combined local file domains -- union of combined local file domains
- 22 - a 'inc/dec' rating service with positive integer rating
- 99 - server administration

If you want to know the services in a client, hit up `/get_services`, which simply gives the above. The same structure appears in a few other calls for convenience, like `/get_files/file_metadata`, since that refers to many different services when it is talking about file locations and ratings and so on.

