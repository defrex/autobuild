---
name: readme-headline
description: Regenerate or verify this repository's tracked README dashboard headline image. Use when the dashboard headline is stale, when dashboard rendering changes, or when asked how the README screenshot is produced.
---

# /readme-headline

The README headline is a generated repository asset. It comes from the
`headline-happy-wide` scenario in the real scripted dashboard capture; do not
take a live terminal screenshot or hand-edit its pixels. The adversarial
`mixed-*` frames remain separate verification-only evidence.

This is repo-local maintainer tooling. It is not part of the shipped Autobuild
CLI or canonical `ab-*` skills, and this procedure does not belong in the
README.

## Regenerate

From anywhere in this checkout, run:

```sh
bun run capture:readme-headline
```

The command drives `tools/dashboard-capture.ts`, selects the unique
`headline-happy-wide` frame by id, and writes its exact PNG bytes to
`docs/assets/headline-wide.png`. Intermediate text, PNGs, and the visual
verification report stay under `.ab/dashboard-frames/`.

Run the command a second time when checking reproducibility; an unchanged
source must produce the same bytes.

## Inspect and check

Open `docs/assets/headline-wide.png` and inspect it at approximately the
README's content width. Confirm the labels remain legible; intake, auto merge,
and Harvest are enabled; Harvest is running with scan complete and synthesize
underway; and the five plausible builds collectively show plan, implement,
code-review, verify, and a merged PR. Confirm a plan/review round count above
one is visible. The headline must contain no blocked, paused, or held state,
failure/error text, capture-fixture identifiers, Unicode stress sample,
row-count preview, or truncation marker.

The adversarial `mixed-wide`, `mixed-narrow`, `unicode-transcript`, and
`resume-prompt` frames are still produced under `.ab/dashboard-frames/` for the
dashboard verifier; do not soften them to improve the headline.

Then run the read-only comparison:

```sh
bun run capture:readme-headline --check
```

The check reruns the capture into `.ab/`, compares the tracked image byte for
byte with `headline-happy-wide`, and fails with the regeneration command if the
asset is missing or stale. It is also part of `bun run check`.

Keep `README.md` unchanged when refreshing the image. In particular, do not
alter its image path, alt text, or surrounding copy unless a separate spec asks
for that documentation change.
