# Autobuild website

The one-page marketing site, reproduced from `design/website/`. Private; never published to npm.

Serve locally with `bun run website:dev` (port 3300, `PORT` overrides). Build static files with `bun run website:build` into `packages/website/dist/`, which any static host can serve with no runtime or environment variables.

The hero dashboard is a captured `ab dispatch` frame, tracked as `src/hero-frame.txt`. Regenerate it with `bun run capture:website-hero` after a dashboard rendering change; `bun run check` verifies it byte for byte.

The link-preview card `src/og.png` is a Chromium screenshot of the card page; regenerate it with `bun run capture:website-og` after changing the headline, the frame, or the styles.
