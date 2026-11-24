# Website evidence capture

Run `bun run capture:website` with Chromium installed (`CHROMIUM_BIN` may select
it). This is repository tooling; no capture script is written into the built site.
The fresh `buildFiles()` map supplies every `docs/**/*.html` output, including
`docs/index.html` and direct HTML pages. Each is captured at 1440 and 390 pixels.
Complete output paths are UTF-8 hex encoded in artifact IDs; nested pages retain
their original URL as the base for relative assets. Public articles are discovered from frontmatter-bearing `docs/*.md`; the
website verify paths include that content root as well as `packages/website/`.

The four existing landing filenames and reference mappings remain stable.
All baseline frames use actual reduced-motion media preference. The report
records stylesheet readiness, stillness and phone overflow for every page.
Landing seam and spacing assertions apply only to landing pages.
`inventory.json` lists successful nonempty PNGs with descriptors and probes,
and the ordered tiles and segments of any tiled or segmented frame;
`verify-report.md` includes the same evidence and records failures plus the
expected inventory if capture aborts. Never interpret a partial inventory as a pass.

## Frame size ceiling

Every PNG is at most the store's decoded artifact ceiling (2,621,440 bytes), so
each one can be attached with `ab artifact put`. A full-page frame that would be
larger is cut losslessly into ordered full-width row tiles named
`<frame-id>-tile-<i>-of-<n>.png`, and its single `<frame-id>.png` is not
written. Its inventory entry keeps the frame and probe and adds `tiles`: each
tile's `id`, `frame`, `index` (1-based), `count`, `top`, `height` and `png`
path. Tiles are contiguous and together cover every row of the page. Frames
that fit are unchanged.

## Tall pages

A full-page frame taller than 16,384 px is shot in balanced vertical segments
(`ceil(height / 16384)` of them, within a pixel of each other) instead of one
very tall browser window. Each segment is its own Chromium run against the
whole page laid out at full height and never scrolled, so sticky sidebars and
the probe measure exactly as in a single shot; the wrapper only clips to the
segment's rows. Each segment must re-measure the same page height and produce
a PNG of exactly its height, so segments cannot gap or overlap.

Each segment is then ceiling-tiled as above. A segmented frame writes no
`<frame-id>.png` and leaves no segment PNG on disk: its `tiles` are the single
page-ordered, contiguous sequence with global `index` and `count`, page-absolute
`top`, and a 1-based `segment`. Its entry also lists `segments`, each with `id`
(`<frame-id>-segment-<i>-of-<n>`), `frame`, `index`, `count`, `top` and
`height`. Pages taller than the 262,144 px sanity ceiling fail capture.

When a page never produces its probe before the browser's time budget expires,
the failure names the frame, the window size and the wrapper's load
diagnostics: whether the iframe loaded, its `readyState`, `location.href` and
whether its body exists.

## Animated figures

Give every figure a unique nonempty `data-capture-figure` ID. Add
`data-capture-animated` to figures that animate. Before page readiness, register
an adapter on `window.__websiteCapture[id]`:

```js
window.__websiteCapture = {
  pipeline: {
    duration: 1000, // finite, positive milliseconds
    ready: Promise.resolve(), // optional; reject on initialization failure
    async seek(timeMs, { still }) {
      // Pause autonomous playback and deterministically render this state.
      // For still=true render the site's actual reduced-motion still state.
      renderState(still ? reducedState : stateAt(timeMs));
      return { timeMs, still, complete: timeMs === 1000 };
    },
  },
};
```

Adapters must settle within the capture's bounded browser time budget. The
capture never freezes arbitrary animations to manufacture reduced-motion
compliance. It checks `matchMedia` inside the actual page and rejects running
or pending document animations. The existing seam knob alone is explicitly
finished before measurement.

For each animated figure at both widths, normal-motion variants seek to zero,
half duration and duration. Other figures acknowledge still state. Every seek
must acknowledge the exact applied time; the final sample must explicitly
acknowledge completion. Both measurement and screenshot navigation repeat this
preparation. Missing/duplicate IDs, missing adapters, invalid durations, rejected
seeks and missing final acknowledgement fail capture. No marked figures is an
explicit zero count, not omitted evidence. Fixture examples and negative cases
live in `website-capture.integration.test.ts`.

## Unit smoke versus full verification

The real-site unit smoke builds and serves the actual site and uses Chromium to
capture the four landing baselines, checking PNG signatures, stylesheet readiness
and remote seam state. It passes explicit landing `frames` and
`includeMotionSamples: false` to `captureWebsite`; baseline figure readiness and
stillness checks remain active. Pure discovery/expansion tests cover the full page
and motion descriptor inventory, and browser fixtures exercise sample seeking.

`includeMotionSamples` defaults to true. `bun run capture:website` and the website
verify step use the full default capture: every docs page at both widths and every
animated figure's start, midpoint and final frames.

## Docs interaction and scroll evidence

When Builds is present, discovery adds `docs-builds-menu` and `docs-builds-toc`
at 390px, `docs-builds-720`, `docs-builds-intermediate` at 1000px, and
`docs-builds-scrolled` at 1440×900. State frames click the production disclosure
buttons or scroll the iframe document to the third section. The scroll frame
keeps a 900px viewport for measurement and screenshot; it is not a full-page
shot. Probes record disclosure ARIA, synchronized active section markers,
expected section from viewport position, sidebar visibility and sticky top
geometry, and code-well containment. Every docs width checks document overflow.
The report and inventory retain these measurements alongside each PNG.

## Landing paint and capture recovery

Landing measurement and screenshots use a real-time CDP navigation, preserving
normal/reduced motion and exact iframe widths. Readiness awaits used fonts,
image settlement/decoding, figure acknowledgements and two animation frames after
layout. The real-time runner bounds readiness; unavailable fonts may use the
existing fallback. Neither font readiness nor animation frames proves compositor
completeness.

Every landing screenshot is decoded before tiling. Rendered text ranges in the
header, hero, section headings, diagrams and footer supply foreground/background
colors and coordinates. Only populated, sufficiently contrasted rectangles are
checked; blank section spacing is excluded. At least 0.5% foreground coverage,
with a permissive antialiasing tolerance, detects missing text without requiring
reference font byte equality. Tiny segment-edge slivers are excluded. Missing
DOM anchors remain page/probe errors. Dimensions and missing foreground are
capture errors. Per-attempt `*-paint-*.json` diagnostics retain coordinates,
coverage and failures. Two fresh-profile attempts are allowed; rejected PNGs
are removed and exhaustion publishes no complete inventory.

A `classification: capture-error` report or visually suspicious missing pixels
requires one complete capture rerun, preserving both reports. A successful rerun
still requires all visual and provenance checks. Never pass incomplete evidence;
if it remains unavailable, attach nothing and use `ab escalate` with report
references, not a site-defect verdict. When the manifest range changes none of a
page's inputs, never fail the build for missing or blank pixels on that page:
rerun once, then escalate if evidence is still incomplete. The manifest range attributes
defects only; it never changes applicability or permits skip. Real defects with
valid evidence still fail, including on changed pages. Missing Chromium retains
its explicit setup-failure verdict.
