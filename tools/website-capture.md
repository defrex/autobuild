# Website evidence capture

Run `bun run capture:website` with Chromium installed (`CHROMIUM_BIN` may select
it). This is repository tooling; no capture script is written into the built site.
The fresh `buildFiles()` map supplies every `docs/**/*.html` output, including
`docs/index.html` and direct HTML pages. Each is captured at 1440 and 390 pixels.
Complete output paths are UTF-8 hex encoded in artifact IDs; nested pages retain
their original URL as the base for relative assets. Docs content must remain
under `packages/website/`; a future external content root must extend the
website verify paths when introduced.

The four existing landing filenames and reference mappings remain stable.
All baseline frames use actual reduced-motion media preference. The report
records stylesheet readiness, stillness and phone overflow for every page.
Landing seam and spacing assertions apply only to landing pages.
`inventory.json` lists successful nonempty PNGs with descriptors and probes;
`verify-report.md` includes the same evidence and records failures plus the
expected inventory if capture aborts. Never interpret a partial inventory as a pass.

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
live in `website-capture.test.ts`.

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
