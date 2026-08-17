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

When importing from the permitted lets-eiigo catalogue, run
`npm run import:lets-eiigo-images`. Its source and unmatched-name records are
written beside the images before rebuilding the manifest.
