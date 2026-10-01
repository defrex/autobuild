# Website

The marketing site is one static page in `packages/website`, reproduced from the approved design in `design/website/`. The package is private and never published to npm.

- `bun run website:dev` serves it on port 3300 (`PORT` overrides), rebuilding on every request.
- `bun run website:build` writes `packages/website/dist/` (`index.html`, `site.css`, `site.js`).

`dist/` is plain static files: any static host can serve it with no server runtime, credentials, or environment variables. On Vercel, set the root directory to `packages/website`, the build command to `bun run build`, and the output directory to `dist`.

The page loads one webfont from Google Fonts and makes no other third-party requests.
