# Autobuild design system

Autobuild looks like the terminal it runs in: one monospace face on a black ground, where every color is a state. The system has two registers on one palette. The **operator** register is the product UI (the web dashboard and `ab dispatch`): one type size, dense, glanceable. The **broadcast** register is for the marketing site, docs and slides: the same face, colors and shapes, with a display scale and system diagrams.

## Voice

Engineer to engineer: direct, confident, plain. Short declarative sentences. No superlatives, no exclamation points, no emoji.

- The name is one word, **Autobuild**, capitalized as a proper noun. Never split into two words or hyphenated. The CLI is `ab`, always in code.
- Headlines are claims in sentence case: "One ticket, one fixed pipeline", "Every seam is an adapter", "One log. Everything else is derived."
- Eyebrows are lowercase locators with a middle dot: `autobuild · the map`, `autobuild · state`.
- The tagline is "Tickets in, PRs out. No babysitting required."
- Use the product's vocabulary verbatim: build, slug, phase or step, `spec`, `plan`, `plan-review`, `implement`, `code-review`, `verify:*`, `finalize`, `reconcile`, `merged`; escalation, blocker, observation, harvest, proposal, operator, auto merge, intake.
- Never invent customers, testimonials, benchmarks, throughput figures or pricing. Example ticket ids and slugs (`AUT-412 add-retry-budget`) are fixtures and read as examples.

## Color

The ground is `ground` (pure black). The theme is dark only; there is no light theme.

**The Color Is State Rule.** A saturated color appears only where it encodes its state:

| token | means | examples |
| --- | --- | --- |
| `title` / `warn` | titles; provisional, held, needs attention | headlines, `[~]`, PAUSED, ESCALATED, `ab escalate` |
| `live` | current, moving, interactive | `[>]`, QUEUED, links, hover, focus ring, agent-write connectors, `revise` loops |
| `ok` | done, good news | `[x]`, RUNNING, merged, done cells, `ab done` |
| `alert` | blocked, failed | BLOCKED, FAILED, failure loops, `!` message lines |

Neutrals carry no meaning: `ink` for text and outlines, `slack` for everything that recedes (eyebrows, captions, connectors, pending steps), `well` for lifted fills (nodes, terminal blocks, fields), `rule` for box-drawing rules only, `dim-line` for unselected chip outlines and empty progress cells in diagrams.

- Never use a primary for emphasis, decoration, or brand alone. A headline is `title` because it is a title.
- On marketing pages, the hues appear inside diagrams and terminal renditions where they mean what they mean in the product. Body copy stays `ink` and `slack`.
- Every text pair clears 4.5:1: `ink` 16.8:1, `title` 12.3:1, `live` 8.9:1, `ok` 8.6:1, `alert` 6.1:1, `slack` 5.9:1 on `ground`; `slack` on `well` 5.2:1. `dim-line` is 1.85:1 and is never the only carrier of meaning.

## Type

One face: JetBrains Mono (Google Fonts), weights 400 and 700 only. Ligatures and contextual alternates off, tabular numerals on. No italic, no letterspacing, no second family.

- **Operator register:** one cell per viewport, `cell-sm` 14/20 below 720px, `cell-md` 15/22 to 1279px, `cell-lg` 16/24 from 1280px. Emphasis is `cell-bold` or a role color, never size.
- **Web register:** `web-display` once per page for the hero line, `web-headline` for section titles (both in `title`), `web-lead` under a headline, `web-body` for running text, `web-label` for diagram and chip labels, `web-eyebrow` for kickers and captions in `slack`, `web-statement` for the bold one-line takeaway under a diagram.
- **Slide register:** the deck's sizes on a 1920 by 1080 canvas: `slide-display`, `slide-title`, `slide-statement`, `slide-body`, `slide-label`, `slide-eyebrow`, with a `slide-margin` of 128px.
- Running text caps at 72ch on web, 80ch in product UI.

## Layout and spacing

Everything is measured in cells: widths in `ch`, heights in rows (`row`, 24px at the large cell). Indent 2ch per level (`gap`); separate glyph tokens by 1ch (`ch`).

- Product UI is a single centered column at most `frame-max` (160ch), in ordinary document flow; only the document scrolls.
- Web sections are separated by `section` (four rows); a headline sits `block` (two rows) above its diagram; a statement line sits `block` below it.
- Pages and slides are left-aligned. Don't center body text.
- Below 720px, diagrams keep their geometry and scroll horizontally inside their own container; text reflows by whole cells.

## Shapes, lines and depth

**The Flat Grid Rule.** No shadows, no gradients, no blur, no translucency, no rounded corners (`none` is the only radius).

- The only border is the 2px `outline`: on buttons (`ink`) and on diagram chips (`ink`, `dim-line`, or dashed `slack` for `+ plugin`).
- Selection and pressed states are reverse video: `ink` fill, `ground` text.
- Dividers are a row of `─` in `rule`, never a CSS hairline.
- Focus is a 2px `live` outline offset 1px.

## Diagrams

Diagrams are how Autobuild explains itself. Build them from Node, Chip, Cells and Connector:

- **Nodes** are `well` boxes with a bold `ink` label (`dispatcher`, `build-runner`, `build store`), optional `slack` sub-lines. `merged` labels in `ok`.
- **Connectors** are 2px, round-capped, orthogonal, with open arrowheads: `slack` solid for flow, `live` solid for agents writing through `ab` and for `revise` loops, `slack` dashed (`dash`, 6 4) for runner-written events, `alert` dashed for failure loops with a bold `alert` label.
- **Cells** show a build's progress: `ok` done, `live` current, `dim-line` outline pending, always beside a `[>] <step>` label.
- **Chips** show adapters on a seam; reverse video marks the selected one; dashed `+ plugin` marks an open seam.
- A diagram gets an eyebrow and headline above and one `web-statement` takeaway below ("Kill anything. It resumes from the log.").
- Label everything with real phase, process, port and adapter names. Never decorate a diagram.

## Iconography and glyphs

Icons are text. The glyph set is `[x] [>] [~] [ ]` for step state, `>` for a lane or selection, `!` for a message line, `$` for a shell prompt, `→` for flow in prose, `·` as a separator, `─` for rules, `▾` for a menu, `×` for close. No icon font, no SVG icon set, no emoji. Screen-reader text names what a glyph's state means.

There is no logo. The wordmark is the name set in `cell-bold` or a display style in `title`; don't draw a mark.

## Imagery

The one image asset is `headline-wide.png`, a rendered `ab dispatch` frame with five builds and a harvest run. It comes from a scripted scenario; its ids and slugs are fixtures. Prefer a live HTML rendition built from BuildRow and StepLine over a screenshot, and never show a real customer's builds.

## Motion

One motion in product UI: a state word flashes reverse video for 180ms when it changes. Marketing pages may animate a diagram stepping through state (cells filling, a `[>]` advancing) when the motion explains the system; nothing loops for decoration. Under `prefers-reduced-motion: reduce`, everything is still.

## Don't

- Don't add a second face, a weight other than 400 and 700, italics, or letterspacing.
- Don't add metric cards, pill badges, sidebars, drawers or modals.
- Don't round a corner, add a shadow, a gradient, or a hairline border.
- Don't use a hue for anything but its state.
- Don't render a light theme.
