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
    fontSize: "1em"
    fontWeight: 700
    lineHeight: "1 row"
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
  word:
    backgroundColor: "transparent"
    border: "0"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
  word-hover:
    backgroundColor: "transparent"
    textColor: "{colors.live-cyan}"
    textDecoration: "underline"
  word-focus:
    outline: "2px solid {colors.live-cyan}"
    outlineOffset: "1px"
  word-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
  word-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.slack}"
  btn:
    backgroundColor: "transparent"
    border: "2px solid {colors.ink}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "0 1ch"
    height: "{spacing.row}"
  btn-hover:
    backgroundColor: "transparent"
    borderColor: "{colors.live-cyan}"
    textColor: "{colors.live-cyan}"
  btn-focus:
    outline: "2px solid {colors.live-cyan}"
    outlineOffset: "1px"
  btn-active:
    backgroundColor: "{colors.ink}"
    borderColor: "{colors.ink}"
    textColor: "{colors.ground}"
  btn-disabled:
    backgroundColor: "transparent"
    borderColor: "{colors.slack}"
    textColor: "{colors.slack}"
  field:
    backgroundColor: "{colors.well}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "0 1ch"
    height: "{spacing.row}"
    rounded: "{rounded.none}"
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

The web dashboard is the `ab dispatch` terminal frame broadcast onto a black character grid. Everything on screen is text set in one monospace face at one size and at the face's natural proportions; the masthead distinguishes itself through bold weight and role color while remaining one row tall. Color is never decoration. Each tempered teletext hue has one job (yellow titles and warns, cyan is current and live, green is done and running, red is blocked and failed), so an operator glancing from a second monitor or a phone reads state from color before reading a word.

The page is dense on purpose and quiet on purpose. Rows stack in cell rhythm, detail unfolds in place beneath the row it belongs to, and the one thing that may raise its voice is the masthead's imperative: a single word (BLOCKED, FAILED, PR READY, MERGED) chosen by priority, in its own tone, that says whether anything needs a human. The story is glance, read one word, act on one row, leave.

The system refuses the ops-console vocabulary: no sidebar, no metric cards, no pill-status table, no decorative hairline borders, no shadows, no gradients, no icon font. Structure comes from the grid, from the shared outline on buttons, from reverse video for pressed states, and from box-drawing rules.

**Key Characteristics:**
- Black ground, dark only; softened ink; four muted teletext hues, each retaining its established job.
- One monospace face (JetBrains Mono) at one natural-proportion size per viewport, weights 400 and 700 only; bold one-row text is the whole display register.
- Every dimension is a whole cell: widths in `ch`, heights in rows, three integer cell sizes across three viewports.
- Bracket glyphs `[x] [>] [~] [ ]` for step state, `>` for the selected and fine-pointer preview lanes, `!` for messages, box-drawing `─` for rules.
- Words act: default controls are ink outlines, row and secondary controls are ghost words, and active states use reverse video.
- One motion, a sub-200ms reverse-video flash on a changed state word, off under reduced motion.

## Colors

The palette tempers the teletext primary set with lower chroma and brightness for long sessions on black. Every hue remains immediately recognizable and carries exactly one meaning; the neutrals carry none.

### Primary
- **Title Yellow** (`title-yellow`): a muted gold-yellow for the repository name in the masthead. Doubles as the warn tone: PAUSED, PAUSING, CLEANING, ESCALATED status words, `(held)` and `(paused)` notes, OFF toggle words, provisional `[~]` steps, dirty-state and diagnostic notices.
- **Live Cyan** (`live-cyan`): a softened cyan for the current `[>]` step in bold, QUEUED and RESUMING status words, open pull requests, requested auto merge, links, selected and fine-pointer preview lane `>` glyphs, caret and focus outline, and every hover on a text control. Cyan means "this is where things are moving or where your pointer is".
- **OK Green** (`ok-green`): a restrained green for done `[x]` steps, RUNNING status, merged pull requests, enabled auto merge, ON toggle words, and the PR READY and MERGED imperatives. Green is quiet good news.
- **Alert Red** (`alert-red`): a tempered coral-red for BLOCKED, FAILED, and ABORTING status words, the BLOCKED and FAILED imperatives, conflicted pull requests, blocker text, setup errors, the abort confirmation line, the sign-in REFUSED word and refusal notice.
### Neutral
- **Ground** (`ground`): the page and the only button background at rest; it is also the ink on reverse-video active states and the flash.
- **Ink** (`ink`): default text, row identity, section headings, the clock, and the border and label of a primary button. It temporarily fills a pressed primary or ghost control.
- **Slack** (`slack`): everything that recedes. Pending `[ ]` steps, key labels in kv lines, field labels, placeholders, separators, identity, closed pull requests, disabled words, and every dimmed row when another row has focus.
- **Well** (`well`): the reverse-video field. Inputs, selects, textareas, transcript and blocker blocks use it; button states do not.
- **Rule** (`rule`): the color of box-drawing rules only.

### Contrast floor
- Text on ground: ink 16.83:1, title/warn yellow 12.26:1, current/live cyan 8.93:1, done/running green 8.61:1, blocked/failed red 6.13:1, and slack 5.92:1.
- Ground-colored text on reverse-video fills uses the corresponding ratio: ink 16.83:1, yellow 12.26:1, cyan 8.93:1, green 8.61:1, red 6.13:1, and blue 5.49:1.
- Slack on the well is 5.20:1.
- Button outlines on ground use ink at 16.83:1, exceeding the 3:1 non-text floor.

### Named Rules
**The Color Is State Rule.** A saturated color appears only where it encodes the state it is assigned to. Yellow warns or titles, cyan is current, green is done, and red is blocked or failed. Never use a primary for emphasis, decoration, or brand.

**The Alert Never Dims Rule.** Focus by dimming lowers ink, cyan, green, yellow, and step colors of unfocused rows to slack; STATUS words, the yellow `(held)` annotation, and red alert lines keep full color because they remain decision-relevant. A blocked row is never dimmed away.

**The Role Token Rule.** Components read role tokens (`--ink`, `--live`, `--ok`, `--warn`, `--alert`, `--slack`, `--well`) and the step and status maps, never the `--tt-*` primaries directly. The palette tunes in one place.

## Typography

**Display Font:** JetBrains Mono (with ui-monospace, Menlo, Consolas, DejaVu Sans Mono, monospace)
**Body Font:** JetBrains Mono (same stack)
**Label/Mono Font:** JetBrains Mono (same stack)

**Character:** One face engineers already have in their terminals, loaded through next/font in weights 400 and 700 with `font-display: optional`, ligatures and contextual alternates off, and tabular numerals on so columns and ticking timers hold their width. The optional display strategy prevents a late face swap from reflowing text after first paint. There is no scale in the conventional sense: one natural-proportion size per viewport, with bold weight and role color for masthead emphasis.

### Hierarchy
- **Display** (700, 1em at the face's natural proportions, one row): the masthead only. Repository name in title yellow, the imperative word in its tone, on the sign-in page "Autobuild operator" and REFUSED. The repository truncates with an ellipsis before the imperative, which always renders whole and remains the most prominent word.
- **Title** (700, 1em, one row): section headings inside detail (Pipeline, Unresolved blockers, Sessions, Transcript), the slug in a build row, the current `[>]` step, STATUS words, ON/OFF toggle words.
- **Body** (400, 1em, one row): everything else. Reading measure is capped at 80ch for composers; row content wraps only on narrow viewports.
- **Label** (400 or 700, 1em, one row): kv keys and field labels in slack at 400; action and state words use 700 where specified.

### Named Rules
**The One Cell Rule.** The cell is 14/20 below 720px, 15/22 to 1279px, 16/24 from 1280px. Nothing sets its own font size, and no element scales one axis independently. Emphasis is weight or role color, never size; the masthead's bold display register occupies exactly one row.

**The Glyph Rule.** Icons are text: `[x] [>] [~] [ ]` for step state, `>` for the selected or fine-pointer preview lane, `!` for the first row of a message, `▾` for a select, `─` for rules, `×N` for the imperative count. No icon font, no SVG icon set, no emoji in the interface.

## Layout

The frame is a single centered column, at most 160ch wide and padded 1ch each side. Masthead, navigation, dispatcher, rows, and inline detail render in ordinary document flow at their natural height. The browser document is the only scroll container; no shell block is fixed or pinned, and rows and detail never scroll inside an inner element. Every vertical measure is a whole row (`--row`) and every horizontal measure is whole characters; the page reflows by cells and never scales fractionally. The three breakpoints do not change the layout so much as the cell: 14/20 to 719px, 15/22 from 720px, 16/24 from 1280px.

Vertical rhythm is one row between blocks (masthead, nav line, dispatcher line, rows, detail sections) and zero rows between lines inside a block. Indentation is 2ch per level: the lane column is 2ch, step lines and messages sit 2ch under their row, detail sits 2ch under the row it unfolds from. Horizontal gaps between words that belong together are 2ch; adjacent step glyph tokens use 1ch.

Before the first frame, five static neutral placeholders reserve the dispatcher and build-list register. Each placeholder occupies the same four-row rhythm as a normal build row and uses only slack/well geometry: no digits, status words, imperative, synthetic values, or animation. Decorative geometry is hidden from assistive technology; one visually hidden polite message announces loading.

**The Flowing Document Rule.** The browser document is the sole scroll container. Masthead, navigation, dispatcher, rows, and inline detail stay in ordinary flow at natural height; no block is pinned and no nested element scrolls rows or detail.

The build row is a grid: a 2ch lane, a ticket-id column sized to the frame's longest id so ids align down the page, a bold slug that fills, right-pinned tokens (auto merge, PR state, held and paused notes), and a right-aligned STATUS column sized to the frame's longest status word. A reserved in-flow control register sits beneath the headline, indented to column 2, before the step line; hiding or revealing its ghost-word controls never changes row geometry. The step line sits beneath, wrapping by whole steps. Below 720px the row drops to three headline columns: STATUS stays pinned right on the first line, the id and slug become inline text that wraps, tokens move to a second line, the control register reserves two rows for two controls per line, the dispatcher separators disappear, and the masthead clock is hidden.
Detail is never a panel or drawer: it unfolds in place beneath the selected row, sets a one-row gap between its sections, and dims the rest of the frame.

## Elevation & Depth

There are no shadows, no gradients, no blur, and no layered or translucent surfaces, fills, panels, or overlays. Buttons rest transparently on the uniform black ground; reverse video appears only while a control is pressed or during a flash. A field or block sits in a slightly lifted well.

### Named Rules
**The Flat Grid Rule.** Nothing casts a shadow, and no surface, fill, panel, or overlay is translucent. A control is distinguished by the shared outline or a ghost word, an active state may invert to reverse video, and a field may sit in the well; that is the full vocabulary.

## Shapes

Every corner is square (`border-radius: 0`) and every shape is a run of whole cells. A shared 2px ink outline is permitted on default buttons and nowhere else. Horizontal rules remain a row of `─` box-drawing glyphs, fields remain reverse-video wells with no stroke, and the keyboard focus indicator is a 2px cyan outline offset 1px. The masthead is a one-row rectangle on the same cell grid.

**The No Hairline Rule.** The shared 2px button outline is the sole component-border exception. No other component draws a border: separation is a row of `─`, a change of fill, or a row of empty space. The offset 2px focus outline remains the keyboard-accessibility indicator.

## Components

### Masthead
A one-row header in the natural-proportion display register. Repository name in title yellow at left, then the bold imperative word in its tone (alert red for BLOCKED and FAILED, ok green for PR READY and MERGED) with `×N` when more than one row carries it, then the poll clock `HH:MM:SS` pinned right in ink, slack while a poll is pending. The repository is the shrinkable column and ellipsizes before the max-content imperative, which always renders whole. One imperative per frame, chosen by priority BLOCKED > FAILED > PR READY > MERGED; nothing is shown when nothing needs a human. The clock is hidden below 720px. The sign-in page reuses the masthead with the product name and REFUSED on a refused sign-in.

### Navigation
- **Style:** a control line with no surface labels with the repository selector only when two or more repositories are configured, followed by identity and `sign out` in slack pinned right. The `repo` label and selector are both absent when there is no choice.
- **Mobile:** the line wraps by whole items; nothing collapses into a menu.

### Buttons
- **Primary / default (`btn`):** transparent on the black ground with a shared 2px ink border and matching bold label, 1ch side padding, square corners, and exactly one row in border-box sizing. This is the form/action treatment for `Answer escalation` and `Continue with GitHub`; the sign-in provider keeps 2ch side padding. Hover changes border and label together to live cyan while remaining transparent. Focus-visible keeps the offset cyan ring outside the border. Active temporarily fills ink with ground text. Disabled remains transparent with a slack border and label and a not-allowed cursor.
- **Secondary / ghost (`word`):** transparent and borderless at rest, inheriting the surrounding ink. This covers row controls, close detail, cancel, sign out, open transcript, and dispatcher toggle words. Row controls use uppercase action vocabulary and sit in reserved in-grid space rather than an overlay. Hover turns cyan and underlines; focus-visible gets the cyan ring; active temporarily fills ink with ground text (including nested ON/OFF text); disabled drops to slack and keeps a transparent ground with a not-allowed cursor.
- **Shape and contrast:** every outline is the same 2px width. Labels meet 4.5:1 and button outlines meet 3:1 against the ground. All controls have distinct rest, hover, focus-visible, active, and disabled states.

### Build Row
Lane (`>` in cyan), ticket id in a frame-wide column, bold slug, right-pinned tokens, and the bold STATUS word in its status color pinned to the right edge. A fixed-height, in-flow register beneath the headline reserves room for the actions available to that status: ABORT; PAUSE, CANCEL PAUSE, RESUME, or DISCARD; AUTO MERGE; and DETAILS or CLOSE. Harvest reserves the same register for its available RESUME or ACKNOWLEDGE run action; the repository Harvest gate remains global. Register words are hidden with visibility at rest, and become visible for committed selection, keyboard focus within the row, or a fine-pointer hover. Hidden words leave the tab order; the row head precedes them in DOM order so focusing it reveals the controls before forward Tab reaches them. At narrow width the register always reserves two rows. Each control's accessible name includes its build slug or Harvest run, and activating it commits that target without toggling detail; DETAILS/CLOSE alone controls detail. Committed selection draws the lane marker bold; on devices with a fine hovering primary pointer, hovering a build or Harvest row draws a regular-weight preview marker in the same reserved lane, and leaving the list removes it. Selection and preview may appear on different rows at once; only committed selection drives focus dimming, detail, and ARIA state. The step line beneath carries each step as glyph, label, and a parenthesised note (`plan(3s)`, `merge(waiting, 8m47s)`) in the terminal's duration format `38s`, `4m12s`, `1h04m`. A build-owned message shows as a three-row preview: `!` on the first row, two-space indent on the rest, a `... N more rows - Enter details` line when truncated, all in the message's tone. Hover turns the identity cyan. When any row is selected, every other row dims to slack except its STATUS word, its yellow `(held)` annotation, and its red lines; the hold remains full-color because it is decision-relevant. An open blocked-build answer is exclusive to the selected row: its register exposes only SUBMIT and CANCEL, so RESUME, ABORT, AUTO MERGE, DETAILS/CLOSE, and their row shortcuts cannot interrupt a draft. Controls on every other row retain their normal target-aware behavior and leave the old answer context when activated.

### Loading Rows
A dispatcher-shaped neutral line followed by five build-row-shaped placeholders reserves the first loaded frame's register. Bars use only well and rule neutrals, remain static, contain no glyphs or values, and are hidden from assistive technology. One visually hidden polite live message names the loading surface once.

### Detail
Unfolds in place under the selected row after a box-drawing rule: a kv line (slack keys, ink values), Pipeline as a vertical step list with round or attempt counts, blockers as red well blocks, the answer composer, Sessions as a wrapped kv line with a cyan `open transcript` word, Transcript as prompt then well-block text. Every section is a bold ink heading with content directly beneath; sections are one row apart. The operator path off a blocked build is also a focused inline step: RESUME opens a red `!` blocker line and a focused optional-guidance field beneath the selected row, without changing whether full detail is open. Empty submit retries, text submits trimmed guidance, and a successful answer resumes through the existing answer lifecycle and closes the local step. While the step is open, the row register contains only SUBMIT and CANCEL; `r` and `a` do not invoke RESUME or ABORT, and the full detail composer keeps Guidance, Retry, Dismiss, Review ceiling, and both revised-spec choices. Esc or CANCEL closes the draft without writing while preserving the selected build and prior detail-open state. A later RESUME may request the prompt again with an empty field; a later ABORT replaces the row with local CONFIRM ABORT/CANCEL confirmation before any durable abort. Activating a control on another row leaves answer mode, selects that target, and performs that row's established action.

### Inputs / Fields
- **Style:** reverse-video well fill, ink text, 1ch side padding, one row minimum, no stroke, square. Selects hide the native arrow and draw a slack `▾` at the right; ordinary textareas start at 8 rows and resize vertically.
- **Label:** a slack word on the row above the field.
- **Focus:** the global 2px cyan outline; the caret is cyan.
- **Placeholder:** slack.

### Rule
A one-row run of `─` in the rule color, unselectable, hidden from assistive technology. The only divider.

### Flash
The system's one motion. When a state word (a STATUS, an imperative, a toggle) changes after mount it inverts to reverse video for 180ms in a single step and returns. Under `prefers-reduced-motion: reduce` the animation is removed; nothing else in the system transitions or animates.

## Do's and Don'ts

### Do:
- **Do** size everything in cells: widths in `ch`, heights in multiples of `--row`, 2ch indents, 1ch between glyph tokens.
- **Do** keep every shell block in ordinary document flow and let only the browser document scroll.
- **Do** read role tokens and the step and status maps; the `--tt-*` primaries are set once in `:root` and never referenced by a component.
- **Do** put one imperative in the masthead by priority (BLOCKED > FAILED > PR READY > MERGED) and leave it empty when nothing needs a human.
- **Do** rest buttons transparently on the ground; use reverse video only for a button's pressed state and the flash.
- **Do** keep STATUS words, yellow `(held)` annotations, and red alert lines at full color when dimming the frame around a selection.
- **Do** carry state in a word and a color together; screen-reader text names the step state the glyph shows.
- **Do** use a red `!` line for both the blocked-build answer step and destructive confirmation, and make destructive intent a second step.

### Don't:
- **Don't** introduce a second face, a second size, letterspacing, non-uniform scaling, or a lighter or heavier weight than 400 and 700; the masthead uses the same natural-proportion cell as the rest of the frame.
- **Don't** draw component borders outside the shared 2px button outline, or add shadows, gradients, or translucent surfaces, fills, panels, or overlays. Separate non-controls with a `─` rule, a fill change, or an empty row.
- **Don't** round a corner.
- **Don't** use a saturated color for anything but its assigned state.
- **Don't** dim a red line, a STATUS word, or a yellow `(held)` annotation, or truncate the imperative before the repository name.
- **Don't** add motion beyond the 180ms state-word flash, and never animate under reduced motion.
- **Don't** use icon fonts, SVG icon sets, or emoji glyphs in the interface; the glyph set is `[x] [>] [~] [ ]`, `>`, `!`, `▾`, `─`, `×`.
- **Don't** build a sidebar, metric cards, a pill-status table, a drawer, or a modal; detail unfolds in place under its row.
- **Don't** invent page numbers (P100, P200); they are deliberately undecided.
- **Don't** render a light theme; the ground is black and `color-scheme` is dark.
