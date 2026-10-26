# Website design reference

The approved design for the Autobuild marketing site, exported from the Claude
Design canvas so builds can read it without access to claude.ai.

- `reference.html` is the page as designed, with the seam selector in its
  initial fully-local state. It renders on its own in a browser. Its markup is
  a design export, not implementation guidance.
- `reference-desktop.png` (1440px wide) and `reference-phone.png` (390px wide)
  and the corresponding `reference-desktop-remote.png` and
  `reference-phone-remote.png` were refreshed on 2026-10-19 using
  `bun run capture:website` from the implemented page for the approved
  project-pinned-install command-copy revision: `bun add -d --exact
  @defrex/autobuild`, `bun ab init`, and `bun ab dispatch`. The remote frames
  switch every seam to remote, with Codex selected as the runtime.
  All four frames were reviewed at their original widths; both phone probes
  reported scrollWidth 390 with innerWidth 390. The longer command wraps in
  the existing layout; no CSS, type, spacing, diagram, or hero assets changed.
  These frames include the existing real dashboard and responsive diagrams
  described below; `reference.html` remains the historical design export.
- The hero dashboard in the reference is drawn by hand and its steps and
  states do not match the product. The built page supersedes it with the
  real `ab dispatch` frame (`packages/website/src/hero-frame.txt`, captured
  from the scripted dashboard scenario), rendered as preformatted text in the
  reference's well; on narrow viewports that frame scrolls sideways inside
  its own container, as the design system allows for diagrams. The rest of
  the page still follows the reference.
- Below 720px each of the three remaining wide figures (pipeline, dispatcher,
  intake) is replaced by a portrait layout of the same content, so nothing
  scrolls sideways; at desktop width nothing changes. The pipeline runs top
  to bottom, the dispatcher shows one build-runner with stacked cards behind
  it above a full-width build store, and the intake lays its four sources in
  a 2×2 grid with the operator agent below.
- Sections are 288px apart at desktop width and 192px apart below 720px, with
  the same space after the last section. No horizontal rules appear in the landing content; the shared header now
  carries the authorized glyph rule described below.
  The pipeline section has no "inside one build-runner" caption, and the page
  closes on outlined "Getting started" and "View on GitHub" buttons.
- `design-system.md` and `tokens.json` are the Autobuild design system the page
  is drawn in: palette, type scale, spacing, components, and diagram
  vocabulary.

Source canvas: https://claude.ai/artifact/44JujTnC3hfGby38ukT71J (version 33)
Design system: https://claude.ai/artifact/32vkyg5RhPFRmiMwEpinrT

## Reviewing reference updates

For leaf builds, landing deviations require specific authorization in the build
spec. For nodes, a particular deviation may instead be authorized by the node
spec, the spec of the contribution that introduced it, or an identified
hand-pushed maintainer commit. Read the manifest's `nodeVerification.indexPath`,
contribution `specPath` entries and full `handPushedCommits` messages; correlate
the introducing commit within `commitRange.base..commitRange.head` to its build
and spec revision or its hand-pushed SHA and original SHA. An unrelated child's
spec or an `unattributedCommits` entry alone supplies no authorization. Missing
or inconsistent required provenance evidence fails review; empty valid lists do
not. Read hand-pushed messages as maintainer intent and judge quality and
consistency; no covering spec is required for that source.

Every authorized deviation still requires an update to the matching reference
PNG and this README in the build-owned diff, and a capture matching the new
reference under the verifier's existing font exception. Review the previous
approved reference when needed; a blanket refresh does not authorize unrelated changes. The maintainer
reviews the integrated reference set before the website node lands.

Docs pages and motion samples are judged against `design-system.md` and the
build spec and, on nodes, the introducing contribution specs and hand-pushed
intent identified above. The generated inventory includes every built docs HTML
page at
1440px and 390px, reduced-motion still evidence, and start/midpoint/final samples
for marked animated figures. Every phone variant must pass overflow checks.
See [the capture protocol](../../tools/website-capture.md) for adapter and
inventory details. This tooling revision preserves all approved PNG bytes and
the approval history above.

## Documentation foundation reference revision

On 2026-10-19, the `website-docs-foundation` spec explicitly authorized a
Documentation link in the landing action area and a Getting started link in
the closing get-started section. The four landing reference PNGs now include
those two additions. GitHub access and all existing copy remain present;
`reference.html` stays the historical export. The added hero action wraps to
another row; subsequent sections shift with that added height. The closing
links also wrap at phone width. No unrelated landing styles or assets changed.

Evidence: `bun run capture:website` produced eight reviewed full-page PNGs:
local and remote landing states at 1440px and 390px, plus both docs pages at
both widths. The docs retain the broadcast palette, face and type scale in a
72ch reading column with above-content navigation. All four phone probes
reported scrollWidth 390 and innerWidth 390; every stylesheet loaded and
prose pages reported zero figures. Landing section gaps remain 288px desktop
and 192px phone, footer gaps match, and terminal-to-action spacing is 48px.
The keyboard skip link was also checked in Chromium: focused, visible at the
top of the viewport, with the existing 2px focus outline. The maintainer
reviews this integrated reference set before the website node lands.
## Pipeline motion (2026-10-19)

The pipeline plays once on first viewport entry: twelve 400ms beats visit spec,
plan, plan-review, plan (revision), plan-review (approval), implement,
code-review, implement (revision), code-review (approval), verify:*, finalize,
and merged. Each review return emphasizes its existing cyan connector. All
labels remain selectable, in place and fully visible. After 4,800ms the drawing
returns to its original colors; the native “Replay animation” word control stays
below it. Replay uses the same controller intended for the other figures.

The four `reference-*.png` baselines listed above continue to represent actual
reduced motion, including the documentation links from the foundation revision above. Reduced motion and disabled JavaScript
show the original complete drawing with no replay control. The additional
`reference-desktop-motion-final.png`, `reference-phone-motion-final.png`,
`reference-desktop-remote-motion-final.png`, and
`reference-phone-remote-motion-final.png` record normal-motion completion with
the replay control visible. They include those same documentation links and come from the same capture adapter at 4,800ms;
they do not replace the reduced-motion baselines. `reference.html` remains the
historical design export.

Review evidence follows [the capture protocol](../../tools/website-capture.md):
one logical `pipeline` marker covers both responsive drawings. Capture seeks
the production timeline at 0, 2,400 and 4,800ms, and checks reduced-motion
stillness and 390px overflow. Separate Chromium playback checks exercise actual
viewport entry, both review returns, keyboard replay, rapid replay, breakpoint
changes, preference changes and the JavaScript-disabled fallback.

## Core workflow documentation reference revision

On 2026-10-19, the `core-workflow-docs` spec authorized one ordinary text link
in each of the existing pipeline, dispatcher, and intake sections, pointing to
`/docs/builds/`, `/docs/dispatcher/`, and `/docs/tickets/`. The four landing
reference PNGs were regenerated from `bun run capture:website` to include
exactly those additions. Section contents below each link shift by the added
paragraph and existing section spacing. The historical `reference.html`,
diagrams, typography, styles, hero assets, and section order are unchanged.
No integration-tree landing section or link is included; AUT-841 owns that work.

The complete capture inventory contains 28 reviewed full-page PNGs: the four
local/remote landing frames and six documentation routes at 1440px and 390px.
The four new guides share the existing Read layout, reference links, and
wrapping navigation. Every phone probe reports scrollWidth 390 and innerWidth
390. All stylesheets loaded, all frames are still under reduced motion, and
the pipeline animation adds twelve normal-motion sample frames across local/remote and desktop/phone variants. Its four final-state references were refreshed to include the same three links, preserving the upstream replay control and animation.
Landing section gaps remain 288px desktop and 192px phone, with matching footer
gaps and 48px terminal-to-action spacing. Docs add no figures and retain the
72ch reading column. A separate focused-link capture confirms the existing
2px cyan outline remains visible on the expanded docs navigation and the new
landing link at phone width. The maintainer reviews the integrated reference
set before the website node lands.

## Operating, seams, and configuration reference revision

On 2026-10-19, the `operating-seams-configuration` spec explicitly authorized
one text link to `/docs/seams/` in the landing seams section. The four landing
reference PNGs now include “Explore the infrastructure seams” below the seam
selector, using the existing cyan underlined link style. Following sections
shift down with the added line; existing copy, diagrams, styles, and assets
remain unchanged. `reference.html` stays the historical design export.

Evidence: `bun run capture:website` produced 14 reviewed full-page PNGs:
local and remote landing states at 1440px and 390px, and all five docs pages
at both widths. All seven phone probes reported scrollWidth 390 and
innerWidth 390. Every frame loaded its stylesheet and reported reduced-motion
still evidence with zero marked animated figures. Landing section gaps remain
288px desktop and 192px phone, footer gaps match, and terminal-to-action
spacing is 48px. The refreshed landing references match these captured PNGs
byte for byte. The maintainer reviews the integrated reference set before the
website node lands.

## Combined documentation and pipeline replay evidence

Reconciliation onto the pipeline-motion change preserves both revisions above.
A fresh capture of the combined site produced 26 reviewed frames: ten docs
stills, four landing stills, and twelve pipeline samples at 0, 2,400 and
4,800ms. Every frame loaded its stylesheet and had no horizontal overflow.
The reduced-motion landing stills match the four seams-link references byte
for byte. The four normal-motion final references are refreshed to include
that same seams link while preserving the completed pipeline and replay
control. The production animation code and timeline remain unchanged.

## Combined core and operating documentation evidence

Reconciliation onto `core-workflow-docs` preserves all seven feature guides,
all nine docs routes, the three upstream landing links, and the seams link.
A fresh capture produced 34 reviewed PNGs: eighteen docs stills, four landing
stills, and twelve pipeline start/midpoint/final samples across both widths
and local/remote states. Every frame loaded its stylesheet and had no sideways
scroll; all seventeen phone probes stayed at 390px. Navigation wraps across
three rows on phones, text and commands remain readable, and docs have no
figures. Pipeline progression, completion, and replay remain unchanged.
The eight landing references now match the combined capture byte for byte,
including all four authorized text links. Section and footer gaps remain
288px desktop and 192px phone; terminal-to-action spacing remains 48px.

## Shared site header (2026-10-20)

The `shared-site-header` spec explicitly authorizes replacing the landing and
all docs mastheads with one shared header. Its pinned `design/docs-layout`
asset revision 0 (exported from the maintainer-approved
https://claude.ai/artifact/D2keNruscKe8J6Ywp1fje6 canvas) supplies the header
contract. The 64px masthead uses the 1440px frame and 32px desktop inset;
a separate 24px row of rule-colored `─` follows it. Below 720px the inset is
16px and Menu reveals only Home, Docs, Changelog and GitHub. The docs layout
and docs navigation inside that menu belong to the next ticket.

All eight reduced-motion baseline and normal-motion final landing references
were refreshed from their matching `capture:website` inventory entries.
The historical HTML export, content, diagrams, animation, section spacing,
and footer remain intact. The header adds a 16px vertical offset to landing
content. The header-only glyph rule is the exception to the historical
no-horizontal-rules statement above.

Evidence: all 34 PNGs were inspected, covering nine docs routes at both
widths, four landing stills and twelve pipeline motion samples. Every phone
probe passes overflow checks, stylesheets load, reduced motion is still,
and normal motion retains its start/midpoint/final progression. Landing gaps
remain 288px desktop and 192px phone, with 48px terminal-to-action spacing.
Separate Chromium checks on Home, Docs and nested Builds at 1440, 720, 719
and 390px verify header geometry, current-link styles, keyboard Enter/Space,
Tab focus rings, 44px menu targets, reverse-video open state, Escape focus
return, breakpoint reset, no sideways scroll and accessible links without JS.
Closed/open keyboard-focus screenshots are retained in build scratch evidence.
## Integration-tree figure reference revision

On 2026-10-19, the `integration-tree-figure` spec authorized the integration
section immediately after the dispatcher: an eyebrow, headline, two-sentence
lead, one link to `/docs/integration/`, and a responsive figure. The desktop
figure places its four-step sequence to the right of the tree; the phone
figure places it below. The drawing keeps main, the node ticket and its branch,
and both child builds visible in the existing broadcast diagram vocabulary.

One logical `data-capture-figure="integration-tree"` marker covers both
responsive drawings. Its six 1,000ms beats show A landing, B restacking onto
the new node head, B landing, node completion, verification, and consented
node landing into main. The complete drawing is the default HTML and the
reduced-motion and JavaScript-disabled state. The figure shares the pipeline's
motion controller and once-on-entry/replay behavior, with one native replay
control for its two responsive drawings. Reduced motion hides that control.

`bun run capture:website` produced a successful 40-PNG inventory at
`.ab/website-frames/inventory.json`: four landing baselines, twelve docs
frames, and twenty-four motion samples across both figures. Every phone probe
reported scrollWidth 390 and innerWidth 390; all stylesheets loaded and all
reduced-motion frames remained still. The four reduced-motion landing
references were copied from that capture. The four `*-motion-final.png`
references were captured in Chromium by seeking both production adapters to
their durations, with both replay controls visible. These supersede the
pipeline-only final-state provenance recorded above.

Separate Chromium playback checks passed for viewport entry, completion,
keyboard and rapid replay, responsive resizing, preference changes, and the
JavaScript-disabled fallback. Visibility handling was exercised with a
synthetic `document.hidden` event. The focused caption correction moved
`land ↑` and `restack → land ↑` below the child build boxes; review of the
refreshed desktop and phone crops marked that collision fix resolved and
approved it to ship. A motion-frame inspection also caught an SVG outline specificity issue; the
corrected capture retains cyan connector paths without rectangular outlines,
and review marked that fix resolved. These verdicts cover those two fixes only.

The historical `reference.html` remains intact. Existing documentation
references and unrelated guides are unchanged. The maintainer reviews the
integrated reference set before the website node lands.

## Combined integration figure and operating guides evidence

Reconciliation onto `operating-seams-configuration` preserves all nine docs
routes and the seams link alongside the integration section. A fresh complete
capture produced 46 PNGs: eighteen docs stills, four landing stills, and
twenty-four motion samples. All 23 phone probes report scrollWidth and
innerWidth of 390; every stylesheet loaded, reduced-motion frames stayed still,
and section/footer spacing passed. The four landing still references include
both additions. Four separate normal-motion final captures seek both production
adapters to completion with both replay controls visible. These eight references
supersede the earlier separate-branch captures; production animation code and
historical reference.html remain unchanged.

## Combined shared header and integration figure references (2026-10-20)

Reconciliation preserves the shared site header and its responsive menu alongside
both animated figures, the operating guides, and all existing landing links.
The eight landing references were regenerated with that combined page: four
actual reduced-motion inventory frames and four normal-motion captures with
both production adapters explicitly at completion and both replay controls
visible. The fresh full capture contains 46 PNGs; every stylesheet loaded,
all 23 phone probes fit 390px, reduced-motion frames remained still, and
section/footer spacing passed. Inventory sheets and native-width header/tree
crops were inspected. Historical HTML and docs reference images are unchanged.

## Dispatcher and intake motion (2026-10-19)

The dispatcher and intake now share the pipeline's one-shot viewport controller,
400ms beat, native Replay animation control, and static fallback. The dispatcher
uses four beats per ready ticket: claim, route, runner start, and state writes
through the CLI and phase-event paths. Earlier runners remain active as later
ones start. The phone drawing emphasizes its existing three stack layers and
common write paths for those same three starts. The intake uses three beats
per source: source filing, routing through the operator agent, and ticket delivery
along the existing route into the dispatcher. The human and escalation branch
remain unchanged. Both sequences finish at 4,800ms by removing every transient
attribute; labels stay selectable throughout.

Only the four `reference-*-motion-final.png` files were refreshed, with all
three production capture adapters sought to completion and all Replay controls
visible. The four reduced-motion landing references remain unchanged and match
the new capture pixel for pixel. Disabled JavaScript keeps the same complete
figures with hidden controls. `reference.html` remains the historical export.

`bun run capture:website` produced 44 reviewed PNGs: four reduced-motion landing
states, four docs frames, and 36 motion samples (three figures, three sample
times, two widths, local and remote seams). All stylesheets loaded, reduced-motion
frames were still, section spacing remained unchanged, and all 390px probes
reported scrollWidth and innerWidth of 390. Separate Chromium checks exercised
actual viewport entry, completion, no repeat on return, keyboard and rapid replay,
breakpoint changes, preference changes, and disabled JavaScript. Controller tests
also cover hidden-tab settling. No external runtime dependency was added.

## Combined documentation, dispatcher, and intake evidence

Reconciliation preserves all nine docs routes, the three core-workflow landing
links, and the infrastructure-seams link alongside all three animated figures.
The four normal-motion final references were regenerated from the combined page
with every production adapter sought to 4,800ms and all Replay controls visible.
The four reduced-motion captures match the upstream references pixel for pixel;
those baseline files remain unchanged. Both final phone probes report
scrollWidth and innerWidth of 390. Section and footer gaps remain 288px desktop
and 192px phone, with 48px terminal-to-action spacing. The full capture retains
separate start, midpoint, and final evidence for each figure and responsive
layout. The maintainer reviews the integrated reference set before the website
node lands.

## Shared-header reconciliation (2026-10-20)

The combined page retains the shared masthead and its mobile menu alongside
all three animated figures and all nine docs routes. The four normal-motion
completion references were regenerated with every production adapter settled
and all Replay controls visible. Reduced-motion references retain the upstream
header and remain unchanged. The full inventory now contains 58 PNGs: four
landing stills, eighteen docs frames, and thirty-six motion samples.
The capture unit test retains the upstream four-frame bound; complete motion
evidence is produced by `bun run capture:website`.

## Combined integration, dispatcher, and intake motion (2026-10-20)

Reconciliation preserves the integration-tree figure and its six 1,000ms beats
alongside the dispatcher and intake sequences, the shared site header, all nine
docs routes, and all existing links. Each of the four figures retains its own
controller, capture adapter, and Replay control. The composition test scopes
the pipeline's sixteen nodes to its own figure.

The four normal-motion completion references were regenerated from this combined
page with every production adapter sought to its own duration (6,000ms for the
integration tree; 4,800ms for the other figures), with all four controls visible.
These supersede the separate-branch normal-motion captures above. The upstream
reduced-motion references and historical HTML are preserved.

The combined full capture contains 70 PNGs: four reduced-motion landing stills,
eighteen docs stills, and forty-eight motion samples across four figures. All
35 phone probes fit 390px, all stylesheets load, and stillness and section/footer
spacing pass. All inventory frames were opened in contact sheets, with larger
desktop/phone dispatcher and intake start/midpoint/final crops. The four landing
stills match the upstream reduced-motion reference files pixel for pixel.
## Docs layout (2026-10-20)

The approved `design/docs-layout` revision 0 asset pinned to `lay-out-the`
contains `docs-desktop.png`, `docs-phone.png`, `docs-phone-menu.png`, and
`docs-phone-toc.png`, plus standalone HTML exports and a README. These define
the docs Read register recorded in `design-system.md`: grouped sticky page
navigation, article, section navigation, phone menu and section disclosure,
and previous/next pager. Export copy is illustrative; current article words
and order remain authoritative. Copy as Markdown and sample callouts were
outside that layout change; the copy action is documented below. Landing references remain unchanged. Capture discovers
all docs pages and also exercises Builds at 720px, 1000px, open phone menu,
open phone TOC, and a fixed-height scrolled desktop viewport.

## Docs Markdown copy (2026-10-20)

The same pinned docs desktop and phone exports now govern the title action.
All nine pages offer Copy as Markdown with announced success/failure, native
keyboard activation, and retry handling. Authored article HTML is unchanged.
Browser coverage exercises all pages at 1440px, 720px, and 390px, checks every
heading and fenced block, and verifies canonical relative links and original
external destinations. Exact fixtures cover nested lists, inline formatting,
entities, and embedded backticks. Capture probes enforce action placement,
minimum target height, and document overflow alongside existing docs evidence.
Landing references are unchanged.

The full capture passed all 75 frames (four landing stills, 23 docs frames,
and 48 motion samples). All PNGs were opened in contact sheets, with larger
crops of every docs title at desktop and phone widths and the 720px/1000px
Builds frames. No visual correction to the approved layout was needed.
Outcome labels keep the action width stable; a pending keyboard copy restores
focus when disabling the action moved it to the document body.

## Static figures, Docs hero action, and centered masthead (2026-10-21)

Maintainer design decisions, made interactively on the integration branch:

- **Static figures.** The stepped animations on the pipeline, dispatcher,
  integration tree and intake figures are removed with their Replay controls,
  capture adapters and motion styles. Each figure is the complete static
  flowchart, still marked with its `data-capture-figure` ID and no longer
  `data-capture-animated`, so capture records no motion samples. The four
  `reference-*-motion-final.png` files are deleted; the history above that
  cites them is superseded.
- **One hero action.** The hero offers the install command and a single
  outlined "Docs" button to `/docs/`. GitHub stays in the masthead and in the
  closing actions. `reference.html` carries the same change in its hero so
  the copy comparison still holds.
- **Centered masthead.** The `─` rule glyph sits mid-line in its 24px row,
  which left 12px more space under the nav than above it. The rule now pulls
  up 12px so it marks the masthead's bottom edge and the nav text is
  vertically centered in the 64px masthead. Everything below moves up 12px.

The four landing references were refreshed from this capture.

## Getting-started hero and plain dev install (2026-10-21)

Maintainer design decisions, made interactively on the integration branch:

- **No hero dashboard.** The hero is the headline, lead and the Docs button.
  The captured `ab dispatch` frame no longer appears on the landing page. It
  still draws the OG card, so `hero-frame.txt` and `capture:website-hero`
  stay. This supersedes the hero-frame notes above.
- **Getting started under the hero.** The four-command terminal from "Start
  with one ticket" now also sits directly below the hero, where the frame
  was. The closing section keeps its copy of it. The hero's install-and-copy
  well and the copy control are gone.
- **Plain dev install.** The site's install command is `bun add -D
  @defrex/autobuild`, without `--exact`, on the landing page and in the
  Getting started guide. The guide calls it a development dependency.

`reference.html` carries the same hero, with the hand-drawn dashboard replaced
by the terminal, so the copy comparison needs no hero exclusion. The four
landing references were refreshed from this capture.

## Hero actions below the commands; no inline docs links (2026-10-21)

Maintainer design decisions, made interactively on the integration branch:

- **Hero order.** Headline, lead, the getting-started terminal, then the
  actions. That's the same shape as the closing section.
- **Two hero actions.** An outlined "Documentation" button to `/docs/`, then
  a ghost "GitHub" button to the repository. The ghost button keeps the
  `.btn` box with a transparent 2px border, sets its label in `slack`, and
  turns `live` on hover. This supersedes the single Docs action above.
- **No inline docs links.** The pipeline, dispatcher, integration, seams and
  intake sections no longer end in a text link to their guide. The masthead
  and the hero carry the way into the docs.

`reference.html` carries the same hero order and buttons. The four landing
references were refreshed from this capture.

## Integration section: break it down, land it whole (2026-10-21)

Maintainer copy and figure decision, made interactively on the integration branch:

- **Copy.** The headline is "Break it down. Land it whole." The lead says a
  big feature splits into as many tickets as it needs, each build lands on
  the feature's own branch, siblings stay in sync, and main sees the whole
  thing once, verified, with consent.
- **Figure.** The drawn main/node/A/B tree and its numbered steps are
  replaced by real `bun ab ticket tree` output for the node that built this
  site: AUT-837 "Website for 1.0" with its eleven finished work tickets. A
  dim summary line follows: eleven tickets landed on
  `ab-node/website-integration`, and main receives one pull request. The
  figure is preformatted text in the `well`, using the dashboard's hues for
  `[node]` (live), `[work]` (slack) and `(Done)` (ok). It has no portrait
  variant; on phone it scrolls sideways inside itself, like the earlier hero
  frame. The ticket list is a fixed snapshot and doesn't update itself.

The four landing references were refreshed from this capture. The copy
comparison still excludes the integration section, which `reference.html`
predates.


## Operator agent naming (2026-10-21)

Maintainer naming decision: the agent role that writes specs, watches the
dispatcher and answers escalations is the **operator agent**, matching the
shipped `ab-operate` skill and the operator tools. "PM agent" overstated the
role, since product calls stay with the human. The intake figure's central
node, its description and `reference.html` now say "operator agent". Copy
reserves "operator" for the agent role and says "you" for the human. The
four landing references were refreshed from this capture.

## Masthead without Changelog (2026-10-24)

Maintainer decision (2026-10-23): the shared site header links Home, Docs and
GitHub only; the Changelog link is removed. `reference-desktop.png` and
`reference-desktop-remote.png` were refreshed from `bun run capture:website`;
the masthead is the only difference (391 pixels). The phone references are
byte-identical to the capture and were not changed. `reference.html` never
carried a Changelog link.


## Merge vocabulary (merge-vocabulary)

The approved product spec replaces the Git integration terms land/landing/landed
with merge/merging/merged. The landing page retains its visual system and layout;
its forge caption, throughput sentence, shared terminal hero and integration
figure now use merge vocabulary. The four desktop/phone local/remote reference
PNGs are refreshed from the real website capture. Reviewed all 36 website frames
in overview sheets and the phone page at full resolution; captures report no
sideways overflow at 390px, unchanged section gaps and zero animated figures.


## Protocol offerings (2026-10-26, hosted-protocol-docs)

The approved `hosted-protocol-docs` spec’s “Concept and reference pages”
seam-option-list criterion authorizes this factual refinement. It removes the
cron choice, keeps the dispatcher seam terminal-only, replaces web UI with
Operator API, labels MCP as stdio MCP and Postgres as remote store, and changes
the switchable-seam count from six to five.

All four local/remote desktop/phone reference PNGs came from `bun run
capture:website` and were reviewed against their preceding references. Reviewed
all 59 captured PNGs in overview sheets and the four landing frames separately.
Every 390px overflow probe passes. Desktop section gaps remain 288px and phone
gaps 192px; phones gain 56px from the authorized chip wrapping. No layout,
typography, palette or interaction-model changes accompany the new labels.
