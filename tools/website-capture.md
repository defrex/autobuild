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
