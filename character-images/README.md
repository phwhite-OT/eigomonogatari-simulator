# Character images

Place one image per character in this directory, named with the URL-encoded
character ID and one of `.webp`, `.avif`, `.png`, `.jpg`, or `.jpeg`.

For example, an ID of `fire-001` is stored as `fire-001.webp`. Then run:

```powershell
npm run build:character-images
npm run build
```

The generated manifest contains only files that exist, so the catalogue keeps
showing a reserved image frame for characters whose image is still missing.

When importing from permitted public catalogue sources, run
`npm run import:lets-eiigo-images`. The importer scans the lets-eiigo catalogue,
all public articles, fixed pages, and media records, plus authorised official
English Story articles and fixed pages. It records the two sources separately in
`lets-eiigo-sources.json` and `official-eigomonogatari-sources.json`, and writes
unmatched-name records beside the images before rebuilding the manifest. Source
registries are written atomically so an interrupted import can safely resume.
