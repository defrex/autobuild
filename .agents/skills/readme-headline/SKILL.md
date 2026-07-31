---
name: readme-headline
description: Regenerate or verify this repository's tracked README dashboard headline image. Use when the dashboard headline is stale, when dashboard rendering changes, or when asked how the README screenshot is produced.
---

# /readme-headline

The README headline is a generated repository asset. It comes from the
`mixed-wide` frame in the real scripted dashboard capture; do not take a live
terminal screenshot or hand-edit its pixels.

This is repo-local maintainer tooling. It is not part of the shipped Autobuild
CLI or canonical `ab-*` skills, and this procedure does not belong in the
README.

## Regenerate

From anywhere in this checkout, run:

```sh
bun run capture:readme-headline
```

The command drives `tools/dashboard-capture.ts`, selects the unique
`mixed-wide` frame by id, and writes its exact PNG bytes to
`docs/assets/headline-wide.png`. Intermediate text, PNGs, and the visual
verification report stay under `.ab/dashboard-frames/`.

Run the command a second time when checking reproducibility; an unchanged
source must produce the same bytes.

## Inspect and check

Open `docs/assets/headline-wide.png` and inspect it at approximately the
README's content width. Confirm the labels remain legible and the dashboard
shows the plan-blocked, implement-blocked, completed/merge-waiting, and Harvest
rows at their distinct pipeline stages.

Then run the read-only comparison:

```sh
bun run capture:readme-headline --check
```

The check reruns the capture into `.ab/`, compares the tracked image byte for
byte with `mixed-wide`, and fails with the regeneration command if the asset is
missing or stale. It is also part of `bun run check`.

Keep `README.md` unchanged when refreshing the image. In particular, do not
alter its image path, alt text, or surrounding copy unless a separate spec asks
for that documentation change.
