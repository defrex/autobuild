# Autobuild website

The static marketing site and evaluator documentation, extending the design from `design/website/`. Private; never published to npm.

Serve locally with `bun run website:dev` (port 3300, `PORT` overrides). Build static files with `bun run website:build` into `packages/website/dist/`, which any static host can serve with no runtime or environment variables.

The hero dashboard is a captured `ab dispatch` frame, tracked as `src/hero-frame.txt`. Regenerate it with `bun run capture:website-hero` after a dashboard rendering change; `bun run check` verifies it byte for byte.

The link-preview card `src/og.png` is a Chromium screenshot of the card page; regenerate it with `bun run capture:website-og` after changing the headline, the frame, or the styles.

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
