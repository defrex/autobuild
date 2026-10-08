# Website

The marketing site is one static page in `packages/website`, reproduced from the approved design in `design/website/`. The package is private and never published to npm.

- `bun run website:dev` serves it on port 3300 (`PORT` overrides), rebuilding on every request.
- `bun run website:build` writes `packages/website/dist/` (`index.html`, `site.css`, `site.js`).

The hero is the real `ab dispatch` dashboard: `packages/website/src/hero-frame.txt` holds the exact colored lines the terminal dashboard painted for the scripted `website-hero` capture, and the page renders them as preformatted HTML with each terminal color mapped to its design token. `bun run capture:website-hero` regenerates the file from the capture, and `bun run check` fails when it is stale.

`dist/` is plain static files: any static host can serve it with no server runtime, credentials, or environment variables. On Vercel, set the root directory to `packages/website`, the build command to `bun run build`, and the output directory to `dist`.

The page loads one webfont from Google Fonts and makes no other third-party requests.
