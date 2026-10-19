# Autobuild website

The static marketing site and evaluator documentation, extending the design from `design/website/`. Private; never published to npm.

Serve locally with `bun run website:dev` (port 3300, `PORT` overrides). Build static files with `bun run website:build` into `packages/website/dist/`, which any static host can serve with no runtime or environment variables.

The hero dashboard is a captured `ab dispatch` frame, tracked as `src/hero-frame.txt`. Regenerate it with `bun run capture:website-hero` after a dashboard rendering change; `bun run check` verifies it byte for byte.

The link-preview card `src/og.png` is a Chromium screenshot of the card page; regenerate it with `bun run capture:website-og` after changing the headline, the frame, or the styles.

Docs live at `/docs/` and `/docs/getting-started/`. Add a page to the ordered registry in `src/docs.ts` to emit its HTML and update every docs navigation. The dev server redirects slashless docs URLs to these canonical paths. Static hosts must serve directory index files.
