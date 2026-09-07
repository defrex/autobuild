---
name: Autobuild operator
description: The terminal dashboard's frame, broadcast on a black character grid where every color is a state.
colors:
  ground: "#000000"
  ink: "#e6e6e6"
  title-yellow: "#d7c84f"
  live-cyan: "#55b8b8"
  ok-green: "#65b868"
  alert-red: "#d96868"
  nav-blue: "#707dcc"
  slack: "#888888"
  rule: "#292929"
  well: "#141414"
typography:
  body:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, Consolas, DejaVu Sans Mono, monospace"
    fontSize: "14px / 15px at 720px / 16px at 1280px"
    fontWeight: 400
    lineHeight: "20px / 22px at 720px / 24px at 1280px"
    letterSpacing: "normal"
    fontFeature: "tabular-nums; calt 0; liga 0"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, Consolas, DejaVu Sans Mono, monospace"
    fontSize: "1em"
    fontWeight: 700
    lineHeight: "1 row"
    letterSpacing: "normal"
  display:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, Consolas, DejaVu Sans Mono, monospace"
    fontSize: "1em, transform scaleY(2)"
    fontWeight: 700
    lineHeight: "1 row, occupying 2 rows"
    letterSpacing: "normal"
rounded:
  none: "0"
spacing:
  ch: "1ch"
  gap: "2ch"
  indent: "2ch"
  row: "var(--row)"
  frame-max: "160ch"
  reading-max: "80ch"
components:
  tab:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "0 1ch"
  tab-active:
    backgroundColor: "{colors.nav-blue}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    padding: "0 1ch"
  word:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  word-hover:
    textColor: "{colors.live-cyan}"
  word-disabled:
    textColor: "{colors.slack}"
  btn:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    padding: "0 1ch"
    height: "{spacing.row}"
  btn-hover:
    backgroundColor: "{colors.live-cyan}"
    textColor: "{colors.ground}"
  btn-disabled:
    backgroundColor: "{colors.well}"
    textColor: "{colors.slack}"
  field:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "0 1ch"
    height: "{spacing.row}"
    rounded: "{rounded.none}"
  fastext-red:
    backgroundColor: "{colors.alert-red}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    padding: "0 1ch"
    height: "{spacing.row}"
  fastext-green:
    backgroundColor: "{colors.ok-green}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    padding: "0 1ch"
    height: "{spacing.row}"
  fastext-yellow:
    backgroundColor: "{colors.title-yellow}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    padding: "0 1ch"
    height: "{spacing.row}"
  fastext-cyan:
    backgroundColor: "{colors.live-cyan}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    padding: "0 1ch"
    height: "{spacing.row}"
  fastext-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
  fastext-disabled:
    textColor: "{colors.well}"
    typography: "{typography.body}"
  status:
    typography: "{typography.label}"
    padding: "0 0 0 2ch"
  masthead-title:
    textColor: "{colors.title-yellow}"
    typography: "{typography.display}"
  well-block:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    padding: "0 1ch"
---

# Design System: Autobuild operator

## Overview

**Creative North Star: "Teletext Dispatch"**

The web dashboard is the `ab dispatch` terminal frame broadcast onto a black character grid. Everything on screen is text set in one monospace face at one size; the only exception is the masthead, which stretches that same size to double height the way a teletext header row does. Color is never decoration. Each tempered teletext hue has one job (yellow titles and warns, cyan is current and live, green is done and running, red is blocked and failed, blue is the navigation surface), so an operator glancing from a second monitor or a phone reads state from color before reading a word.

The page is dense on purpose and quiet on purpose. Rows stack in cell rhythm, detail unfolds in place beneath the row it belongs to, and the one thing that may raise its voice is the masthead's imperative: a single word (BLOCKED, FAILED, PR READY, MERGED) chosen by priority, in its own tone, that says whether anything needs a human. The story is glance, read one word, act on one row, leave.

The system refuses the ops-console vocabulary: no sidebar, no metric cards, no pill-status table, no hairline borders, no shadows, no gradients, no icon font. Structure comes from the grid, from reverse-video fills, and from box-drawing rules, all of which the terminal already uses.

**Key Characteristics:**
- Black ground, dark only; softened ink; five muted teletext hues, each retaining its established job.
- One monospace face (JetBrains Mono) at one size per viewport, weights 400 and 700 only; double height via `scaleY(2)` is the whole display register.
- Every dimension is a whole cell: widths in `ch`, heights in rows, three integer cell sizes across three viewports.
- Bracket glyphs `[x] [>] [~] [ ]` for step state, `>` for the selected lane, `!` for messages, box-drawing `─` for rules.
- Words act: controls are text, active surfaces are reverse video, the Fastext row carries four fixed-color cells.
- One motion, a sub-200ms reverse-video flash on a changed state word, off under reduced motion.

## Colors

The palette tempers the teletext primary set with lower chroma and brightness for long sessions on black. Every hue remains immediately recognizable and carries exactly one meaning; the neutrals carry none.

### Primary
- **Title Yellow** (`title-yellow`): a muted gold-yellow for the repository name in the masthead, ticket-queue state headings, markdown headings and table heads. Doubles as the warn tone: PAUSED, PAUSING, CLEANING, ESCALATED status words, `(held)` and `(paused)` notes, OFF toggle words, provisional `[~]` steps, dirty-state and diagnostic notices.
- **Live Cyan** (`live-cyan`): a softened cyan for the current `[>]` step in bold, QUEUED and RESUMING status words, open pull requests, requested auto merge, links, the selected lane `>` glyph, caret and focus outline, and every hover on a text control. Cyan means "this is where things are moving or where your pointer is".
- **OK Green** (`ok-green`): a restrained green for done `[x]` steps, RUNNING status, merged pull requests, enabled auto merge, ON toggle words, and the PR READY and MERGED imperatives. Green is quiet good news.
- **Alert Red** (`alert-red`): a tempered coral-red for BLOCKED, FAILED, and ABORTING status words, the BLOCKED and FAILED imperatives, conflicted pull requests, blocker text, setup errors, the abort confirmation line, the sign-in REFUSED word and refusal notice.
- **Nav Blue** (`nav-blue`): a quiet periwinkle-blue reverse-video fill behind the active surface tab, and nothing else. It uses ground-colored ink for contrast. Blue is a place, not a state.

### Neutral
- **Ground** (`ground`): the page, the only background at rest, and the ink on every reverse-video fill (tabs, buttons, Fastext cells, the flash).
- **Ink** (`ink`): default text, row identity, section headings, the clock, the fill of the primary text button. Also the hover fill of a Fastext cell.
- **Slack** (`slack`): everything that recedes. Pending `[ ]` steps, key labels in kv lines, field labels, placeholders, separators, identity, closed pull requests, disabled words, and every dimmed row when another row has focus.
- **Well** (`well`): the reverse-video field. Inputs, selects, textareas, transcript and blocker blocks, markdown preview, and the disabled state of the primary button. Also the dropped ink color of a disabled Fastext cell.
- **Rule** (`rule`): the color of box-drawing rules only.

### Contrast floor
- Text on ground: ink 16.83:1, title/warn yellow 12.26:1, current/live cyan 8.93:1, done/running green 8.61:1, blocked/failed red 6.13:1, nav blue 5.49:1, and slack 5.92:1.
- Ground-colored text on reverse-video fills uses the corresponding ratio: ink 16.83:1, yellow 12.26:1, cyan 8.93:1, green 8.61:1, red 6.13:1, and blue 5.49:1.
- Resolved `nav-ink` on `nav-fill` is ground on nav blue at 5.49:1. Slack on the well is 5.20:1.

### Named Rules
**The Color Is State Rule.** A saturated color appears only where it encodes the state it is assigned to. Yellow warns or titles, cyan is current, green is done, red is blocked or failed, blue is the active tab. Never use a primary for emphasis, decoration, or brand.

**The Fastext Identity Rule.** The four Fastext slot colors (red, green, yellow, cyan, left to right) are the slot's identity and never encode state. An empty slot stays colored; a disabled cell keeps its fill, drops its key letter, and falls to weight 400 in well-colored ink. Hover on any cell is white fill.

**The Alert Never Dims Rule.** Focus by dimming lowers ink, cyan, green, yellow, and step colors of unfocused rows to slack; STATUS words and red alert lines keep full color. A blocked row is never dimmed away.

**The Role Token Rule.** Components read role tokens (`--ink`, `--live`, `--ok`, `--warn`, `--alert`, `--slack`, `--well`) and the step and status maps, never the `--tt-*` primaries directly. The palette tunes in one place.

## Typography

**Display Font:** JetBrains Mono (with ui-monospace, Menlo, Consolas, DejaVu Sans Mono, monospace)
**Body Font:** JetBrains Mono (same stack)
**Label/Mono Font:** JetBrains Mono (same stack)

**Character:** One face engineers already have in their terminals, loaded through next/font in weights 400 and 700, with ligatures and contextual alternates off and tabular numerals on so columns and ticking timers hold their width. There is no scale in the conventional sense: one size per viewport, bold for emphasis, and double height for the masthead.

### Hierarchy
- **Display** (700, 1em stretched by `scaleY(2)`, one row of line height occupying two rows): the masthead only. Repository name in title yellow, the imperative word in its tone, on the sign-in page "Autobuild operator" and REFUSED. Truncates with an ellipsis; the imperative never truncates before the repository name does.
- **Title** (700, 1em, one row): section headings inside detail (Pipeline, Unresolved blockers, Sessions, Transcript), the slug in a build row, the title in a ticket row, the current `[>]` step, STATUS words, ON/OFF toggle words, tab labels. Ticket-queue state headings are uppercase in title yellow with a weight-400 count.
- **Body** (400, 1em, one row): everything else. Reading measure is capped at 80ch for composers and 100ch for ticket detail; row content wraps only on narrow viewports.
- **Label** (400 or 700, 1em, one row): kv keys and field labels in slack at 400; Fastext labels uppercase at 700 with a 400 key letter.

### Named Rules
**The One Cell Rule.** The cell is 14/20 below 720px, 15/22 to 1279px, 16/24 from 1280px. Nothing sets its own font size. Emphasis is weight or color, never size; the only taller text is the masthead's `scaleY(2)`.

**The Glyph Rule.** Icons are text: `[x] [>] [~] [ ]` for step state, `>` for the selected lane, `!` for the first row of a message, `▾` for a select, `─` for rules, `×N` for the imperative count. No icon font, no SVG icon set, no emoji in the interface.

## Layout

The frame is a single centered column, at most 160ch wide, padded 1ch each side, filling at least the viewport height so the Fastext row can sit at the bottom. Every vertical measure is a whole row (`--row`) and every horizontal measure is whole characters; the page reflows by cells and never scales fractionally. The three breakpoints do not change the layout so much as the cell: 14/20 to 719px, 15/22 from 720px, 16/24 from 1280px.

Vertical rhythm is one row between blocks (masthead, nav line, dispatcher line, rows, detail sections) and zero rows between lines inside a block. Indentation is 2ch per level: the lane column is 2ch, step lines and messages sit 2ch under their row, detail sits 2ch under the row it unfolds from, blockquotes and lists in markdown indent 2ch. Horizontal gaps between words that belong together are 2ch; between adjacent glyph tokens (steps, Fastext key and label) 1ch.

The build row is a grid: a 2ch lane, a ticket-id column sized to the frame's longest id so ids align down the page, a bold slug that fills, right-pinned tokens (auto merge, PR state, held and paused notes), and a right-aligned STATUS column sized to the frame's longest status word. The step line sits beneath, wrapping by whole steps. Below 720px the row drops to three columns: STATUS stays pinned right on the first line, the id and slug become inline text that wraps, tokens move to a second line, the dispatcher separators disappear, and the masthead clock is hidden. The Fastext row goes from four cells to two per line.

Ticket pages fill `minmax(40ch, 1fr)` columns with 4ch between, one column below 720px. Detail is never a panel or drawer: it unfolds in place beneath the selected row, sets a one-row gap between its sections, and dims the rest of the frame.

## Elevation & Depth

There are no shadows, no gradients, no blur, and no layered surfaces. Depth is conveyed only by reverse video: an active tab, a primary button, a Fastext cell, or a flash inverts ink and fill; a field or block sits in a slightly lifted well. The Fastext row is sticky at the bottom with a ground-colored fill so content scrolls beneath it, which is the only stacking in the system.

### Named Rules
**The Flat Grid Rule.** Nothing casts a shadow and nothing is translucent. If a surface needs to read as distinct, it inverts to reverse video or sits in the well; that is the full vocabulary.

## Shapes

Every corner is square (`border-radius: 0`) and every shape is a run of whole cells. There are no hairline borders anywhere: horizontal rules are a row of `─` box-drawing glyphs in the rule color, fields are reverse-video wells with no stroke, and the focus indicator is a 2px cyan outline offset 1px, which is the one line thinner than a cell and exists for keyboard accessibility. The masthead is the one non-rectangular gesture, and it is still a rectangle two rows tall.

**The No Hairline Rule.** Borders finer than a cell are not drawn. Separation is a row of `─`, a change of fill, or a row of empty space.

## Components

### Masthead
A two-row header in the display register. Repository name in title yellow at left, then the imperative word in its tone (alert red for BLOCKED and FAILED, ok green for PR READY and MERGED) with `×N` when more than one row carries it, then the poll clock `HH:MM:SS` pinned right in ink, slack while a poll is pending. One imperative per frame, chosen by priority BLOCKED > FAILED > PR READY > MERGED; nothing is shown when nothing needs a human. The clock is hidden below 720px. The sign-in page reuses the masthead with the product name and REFUSED on a refused sign-in.

### Navigation
- **Style:** a line of uppercase bold tab words (BUILDS, TICKETS) padded 1ch, followed by the repo select, with identity and `sign out` in slack pinned right.
- **Active:** reverse video in nav blue fill with ground-colored ink; there is no underline or indicator glyph.
- **Hover:** inactive tabs turn live cyan.
- **Mobile:** the line wraps by whole items; nothing collapses into a menu.

### Buttons
- **Word (default control):** a plain text word in the surrounding ink (`pause`, `resume`, `sign out`, `open transcript`, `close detail`). Hover turns cyan and underlines; disabled drops to slack with a not-allowed cursor. Toggle words name the action (INTAKE, AUTO MERGE, HARVEST) and the dispatcher line carries the bold ON in green or OFF in yellow beside them.
- **Primary (`btn`):** reverse video, ink fill with ground text, bold, 1ch side padding, one row tall (`Answer escalation`, `Save`, `Create`). Hover fills cyan; disabled fills well with slack text.
- **Shape:** square; every button is a run of cells.

### Fastext
The key legend as a sticky footer of four cells, left to right red, green, yellow, cyan. Each cell is one row tall, ground-colored bold text on the slot color, a weight-400 key letter (`a`, `r`, `m`, `↵`, `Esc`) then the uppercase label. The key letter is hidden on coarse pointers. Cells change contents per context (list, detail, abort confirmation, ticket queue) but never change color; an empty slot renders as a colored cell with no text; a disabled cell keeps its fill, drops the key, and falls to weight 400 in well-colored ink. Hover fills white. Two per line below 720px. The sign-in provider button is a single green Fastext cell with 2ch padding.

### Build Row
Lane (`>` in cyan when selected), ticket id in a frame-wide column, bold slug, right-pinned tokens, and the bold STATUS word in its status color pinned to the right edge. The step line beneath carries each step as glyph, label, and a parenthesised note (`plan(3s)`, `merge(waiting, 8m47s)`) in the terminal's duration format `38s`, `4m12s`, `1h04m`. A build-owned message shows as a three-row preview: `!` on the first row, two-space indent on the rest, a `... N more rows - Enter details` line when truncated, all in the message's tone. Hover turns the identity cyan. When any row is selected, every other row dims to slack except its STATUS word and its red lines.

### Detail
Unfolds in place under the selected row after a box-drawing rule: a kv line (slack keys, ink values), Pipeline as a vertical step list with round or attempt counts, blockers as red well blocks, the answer composer, Sessions as a wrapped kv line with a cyan `open transcript` word, Transcript as prompt then well-block text. Every section is a bold ink heading with content directly beneath; sections are one row apart. The destructive path is two steps: `abort` shows a red `! abort <slug>? Enter confirms, Esc cancels` line and swaps the Fastext row to ABORT and CANCEL before anything writes.

### Inputs / Fields
- **Style:** reverse-video well fill, ink text, 1ch side padding, one row minimum, no stroke, square. Selects hide the native arrow and draw a slack `▾` at the right; textareas start at 8 rows (14 in ticket detail) and resize vertically.
- **Label:** a slack word on the row above the field.
- **Focus:** the global 2px cyan outline; the caret is cyan.
- **Placeholder:** slack.

### Ticket Row and Pages
State pages are columns headed by the uppercase state name in title yellow with a weight-400 count in ink. Each row is a 2ch lane and the ticket id then bold title, with a slack meta line beneath (labels, `blocked by` in yellow). Hover turns the title cyan; the selected row shows the `>` lane. Markdown preview sits in a well and keeps its marks: headings in title yellow prefixed by a slack `#`, `##`, or `###`, `- ` list markers, 2ch-indented slack blockquotes, code on ground, `─` horizontal rules.

### Rule
A one-row run of `─` in the rule color, unselectable, hidden from assistive technology. The only divider.

### Flash
The system's one motion. When a state word (a STATUS, an imperative, a toggle) changes after mount it inverts to reverse video for 180ms in a single step and returns. Under `prefers-reduced-motion: reduce` the animation is removed; nothing else in the system transitions or animates.

## Do's and Don'ts

### Do:
- **Do** size everything in cells: widths in `ch`, heights in multiples of `--row`, 2ch indents, 1ch between glyph tokens.
- **Do** read role tokens and the step and status maps; the `--tt-*` primaries are set once in `:root` and never referenced by a component.
- **Do** keep the Fastext row's four colors fixed left to right and let the labels carry the action.
- **Do** put one imperative in the masthead by priority (BLOCKED > FAILED > PR READY > MERGED) and leave it empty when nothing needs a human.
- **Do** use reverse video for anything active or pressable that is not a plain word: tabs, primary buttons, Fastext cells, the flash.
- **Do** keep STATUS words and red alert lines at full color when dimming the frame around a selection.
- **Do** carry state in a word and a color together; screen-reader text names the step state the glyph shows.
- **Do** make destructive intent a second step with a red `!` confirmation line.

### Don't:
- **Don't** introduce a second face, a second size, letterspacing, or a lighter or heavier weight than 400 and 700; the only taller text is the masthead's `scaleY(2)`.
- **Don't** draw hairline borders, shadows, gradients, or translucent surfaces. Separate with a `─` rule, a fill change, or an empty row.
- **Don't** round a corner.
- **Don't** use a saturated color for anything but its assigned state, and never encode state in a Fastext slot color.
- **Don't** dim a red line or a STATUS word, or truncate the imperative before the repository name.
- **Don't** add motion beyond the 180ms state-word flash, and never animate under reduced motion.
- **Don't** use icon fonts, SVG icon sets, or emoji glyphs in the interface; the glyph set is `[x] [>] [~] [ ]`, `>`, `!`, `▾`, `─`, `×`.
- **Don't** build a sidebar, metric cards, a pill-status table, a drawer, or a modal; detail unfolds in place under its row.
- **Don't** invent page numbers (P100, P200); they are deliberately undecided.
- **Don't** render a light theme; the ground is black and `color-scheme` is dark.
