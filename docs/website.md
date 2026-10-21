# Website

The marketing site and multi-page evaluator documentation are static HTML in `packages/website`, reproduced from the approved design in `design/website/`. The package is private and never published to npm.

- `bun run website:dev` serves it on port 3300 (`PORT` overrides), rebuilding on every request.
- `bun run website:build` writes `packages/website/dist/` (`index.html`, `site.css`, `site.js`, `og.png`, and generated `docs/**/index.html`).

Public docs are authored in `docs/*.md`, with opt-in YAML frontmatter:

```yaml
---
title: Example page
group: guides
order: 10
description: What you will learn.
# Optional short nav label and route override:
label: Example
slug: example
---

# Example page
```

The opening h1 must match `title` and is consumed into the existing page layout.
Groups sort as `start`, `concepts`, `guides`, `reference`, then by numeric `order`
and filename. The filename stem is the default slug; `slug: ""` selects `/docs/`.
Routes use `/docs/<slug>/` and emit directory indexes. Slugs contain lowercase
letters, digits and single hyphens. Metadata and route collisions fail the build.
Files without frontmatter are reference-only and never published, including
`docs/website.md` and the dispatcher cutover and sandbox rollout probes.

Use relative Markdown links such as `[Builds](builds.md#one-build)` so GitHub
resolves them. The generator maps links to published files to their site routes,
preserving queries and fragments; reference-only Markdown targets link to GitHub.
Missing Markdown targets fail the build. External links and same-page anchors
stay as written. Keep article text in Markdown, not in website TypeScript.

Build and dev requests discover pages afresh; adding a file requires no website
registry edit. `bun run capture:website` captures every generated docs page at
1440px and 390px, plus interaction states; inspect the PNGs and report under
`.ab/website-frames/`. Static hosts must serve directory index files. The dev
server redirects slashless docs URLs to canonical trailing-slash paths.

`bun run check` enforces complete-byte parity for same-named files shared by
`docs/` and `skills/guide/references/`, including their live and pristine installed
copies. Edit docs first and synchronize all three guide copies in the same
commit. Publication metadata is part of those bytes; guide-only references do
not need a public counterpart.

The hero is the real `ab dispatch` dashboard: `packages/website/src/hero-frame.txt` holds the exact colored lines the terminal dashboard painted for the scripted `website-hero` capture, and the page renders them as preformatted HTML with each terminal color mapped to its design token. `bun run capture:website-hero` regenerates the file from the capture, and `bun run check` fails when it is stale.

Shared links preview through Open Graph and Twitter card tags in each page head, pointing at `og.png`, a 1200×630 card drawn from the same frame in the site's own styles. `bun run capture:website-og` screenshots it with a local Chromium into `packages/website/src/og.png`; rerun it after changing the headline, the hero frame, or the styles, and look at the result, since font rasterization differs between machines and nothing checks the bytes. The canonical origin every absolute URL is built from is `SITE_URL` in `packages/website/src/constants.ts`.

`dist/` is plain static files: any static host can serve it with no server runtime, credentials, or environment variables. On Vercel, set the root directory to `packages/website`, the build command to `bun run build`, and the output directory to `dist`.

Each page loads one webfont from Google Fonts and makes no other third-party requests.
