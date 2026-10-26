---
name: Autobuild ANSI
description: State colors on two calm grounds, with readable human language.
colors:
  light-ground: "#fbfbfc"
  light-ink: "#1a1d24"
  light-slack: "#5f6571"
  light-rule: "#dfe2e8"
  light-well: "#f5f6f8"
  light-blue: "#2557e6"
  light-green: "#10862f"
  light-amber: "#b35c00"
  light-teal: "#007f8a"
  light-red: "#d32b33"
  light-red-wash: "#fef2f1"
  light-select: "#c9d5f7"
  dark-ground: "#101219"
  dark-ink: "#dcdfe5"
  dark-slack: "#858b97"
  dark-rule: "#262a35"
  dark-well: "#181b24"
  dark-blue: "#86a3f2"
  dark-green: "#8fcf6e"
  dark-amber: "#e8aa52"
  dark-teal: "#52c3c3"
  dark-red: "#f07777"
  dark-red-wash: "#2a1719"
  dark-select: "#2c3a66"
typography:
  body:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  body-wide:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1em"
    fontWeight: 600
    lineHeight: 1.5
  machine:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "0.93em"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  square: "0"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
components:
  button:
    rounded: "{rounded.square}"
    padding: "3px 12px"
  field:
    rounded: "{rounded.square}"
    padding: "4px 10px"
---

# Design System: Autobuild ANSI

## Overview

**Creative North Star: "ANSI"**

ANSI keeps the terminal’s functional color and precise machine values while giving people readable titles and plain-language help. The visual register is calm, direct and practical: glance, find the state that needs attention, act on one row, leave.

Both grounds are first-class. Structure comes from type, spacing and rules rather than decorative surfaces. The recorded world applies to the operator web app, not the terminal dashboard or marketing website.

**Key Characteristics:**
- Two calm grounds with state-specific inks.
- Human language in sans; machine values in mono.
- Title-led ruled rows and inline decisions.
- Square controls and document flow.

The current app title is “Autobuild operator”. Its eventual title and any page-number system remain undecided. The approved ANSI direction replaces the previous visual authority entirely.

## Colors

### Primary

Functional state inks are the only chromatic signals: green for success/running, amber for provisional or held work, teal for current/live, blue for identity and links, red for failure or a human blocker. Their exact light and dark primitives are in frontmatter and `app/globals.css`.

### Neutral

Ground is the page; ink carries primary reading; slack carries secondary text and pending state; rule separates rows; well supports fields, transcripts and loading placeholders. Red wash belongs to escalation decisions. Selection has its own ground-specific fill.

**The Two Grounds Rule.** Light and dark are equal supported grounds. Use the matching palette as a whole; never transplant an ink from the other ground.

**The Color Is State Rule.** Green marks done or running, amber marks provisional progress, retries, held work and consent, teal marks the current step and live interaction, blue identifies tickets and links, red marks blocked or failed, and slack marks pending. Status and step words carry meaning alongside color.

Every state ink meets 4.5:1 on its matching ground. Ink, slack and red also meet 4.5:1 on well and red wash. These tested pairs are not permission to combine arbitrary colors and surfaces: light amber fails on the well and belongs only on ground. Primary controls use ground text on ink, or on teal for hover, in both palettes. Structural rules need not carry text contrast.

System is the default theme. The account menu offers System, Light and Dark. Browser storage key `autobuild.theme` persists the choice; a synchronous head bootstrap sets `data-theme` before paint. System removes that override and CSS follows live `prefers-color-scheme`. Invalid preferences fall back to System; storage failure leaves the UI usable. Native controls follow the matching `color-scheme`.

## Typography

Self-hosted variable assets are `app/fonts/AtkinsonHyperlegibleNext.ttf` and `app/fonts/JetBrainsMono.ttf`, loaded through `next/font/local` with swap display and CSS variables `--font-sans` and `--font-mono`. Their bundled OFL licenses and provenance live alongside them; no runtime third-party font request is needed.

Body is 15px, rising to 16px at 1280px, at 1.5 line height. Sans regular (400) carries prose; semibold (600) carries row titles and actions; bold (700) carries brand and stronger headings. Machine values generally use 0.93em mono, with tabular figures and disabled contextual ligatures in the utility register. Avoid repeatedly shrinking nested values. Status and current-step emphasis uses 700. Detail headings are 1.05em; sign-in headings are 1.6em with 1.2 line height. Connection approval gives its exact device code a distinct large bold mono line.

**The Semantic Type Rule.** Use Atkinson Hyperlegible Next for titles, captions, questions and explanatory prose. Use JetBrains Mono for ticket ids, slugs, steps, durations, repository identities, codes and other machine values.

**The Glyph Rule.** Retain the textual step marks [x], [>], [~], [ ] and their accessible state names. Existing text controls may use menu or close glyphs; never introduce an icon set or emoji.

## Layout

The centered frame has a maximum width of 1180px, 24px side padding and 64px bottom padding. Below 720px, side padding is 16px and bottom padding 40px. The masthead and wrapping operator control line precede ruled rows. The desktop identity column is 6.5rem with a 16px gutter; slug, steps and build-page sections align beneath the title. The readable measure token is 72ch; sign-in centers within 56ch, answer composers within 80ch, sign-off regions within 88ch.

At phone width the row identity stacks, content loses its desktop indent, and steps and controls wrap naturally. Escalation sign-off spans the viewport edge to edge, with full-width primary answer controls. The account menu stretches across the phone viewport; long identities and prose wrap without truncating the facts.

**The Title First Rule.** The readable ticket title is the primary row text; use the slug when no title exists. Keep identity, status, slug and steps visible without opening detail.

**The Flowing Document Rule.** The browser document owns scrolling. Masthead, controls, build rows and build pages remain in ordinary flow at natural height, without pinned content or nested scrolling panels. The account menu is the small anchored overlay exception, full-width on phones.

## Elevation & Depth

There are no shadows, gradients or translucent layers. Ground, inset well and red wash convey function, not elevation. The account and project menus use an opaque ground and a thin slack-gray outline. Loading uses static neutral placeholders with a hidden polite announcement, never fabricated zero facts. No decorative state animation is part of the system.

## Shapes

**The Square Rules Rule.** Use square corners, one-pixel structural rules and thin outlined controls. No shadows, gradients, rounded pills or filled status badges.

Structural masthead, control-line and row separators are 1px. Buttons, fields, menu and decision boxes use 1.5px outlines. Keyboard focus is a visible 2px teal outline offset by 2px; it is an accessibility indicator rather than elevation.

## Components

### Buttons and word actions

Outlined buttons use semibold sans, square corners and 3px 12px padding. Primary buttons invert ink and ground; hover uses teal. Secondary buttons stay transparent with an ink outline. Word actions are underlined text with a subtle rule-colored underline, becoming teal on hover. Disabled controls use slack, remain identifiable, and cannot imply success. Selected theme choices use bold ink rather than a filled badge.

### Fields

Fields use mono values, well background, 1.5px rule outlines and 4px 10px padding. Focus changes the border to teal as well as retaining the visible focus outline. Textarea height starts at 72px and can resize vertically. Labels and help remain sans.

### Masthead and account menu

A ruled masthead pairs the project identity, which is the project picker when more than one project is reachable, with an account trigger. Both menus are opaque, square lists outlined in slack gray; the account menu carries account actions and the System / Light / Dark theme choices. It has no shadow. Operator controls wrap under the masthead; machine counters and times retain mono.

### Build rows, progress and detail

A blue mono ticket id precedes the sans title; a mono lifecycle word sits to the right. The slug and PR/auto-merge facts form a secondary register, then the wrapping step list. Step timing keeps the terminal duration format: `38s`, `4m12s`, `1h04m07s`. Legend marks repeat the green, teal, amber and slack mapping while explaining it in plain sans. Rows never expand in place: the title links to the build's own page, which repeats the row's identity and meta line under a back link, then carries the escalation answer, merge consent, Actions, pipeline, sessions and transcript. A blocked row keeps its red question and links to that page to answer; merge consent stays on the row as well. Answering and abort confirmation have exclusive controls on the page.

### Decision regions

**The Sign-off Rule.** Reserve a bordered sign-off region for a human decision. Escalation uses red question and border on red wash with plain explanatory copy; merge consent uses amber on the plain ground, never on the well.

Escalations show the red question followed by the factual sentence explaining that a human answer resumes work. Merge consent retains Merge / Hold. Answer forms and destructive confirmations stay inline; primary/secondary control hierarchy remains clear while pending. Auth and connection pages use the same frame, sans help, mono identities and square controls, with accurate access copy.

### Organization reading pages

Members, Organizations and Projects extend the Flowing Document rule with a
left-aligned reading measure below the shared account masthead. Ruled roster
rows show identity, role and explicit JOINED/PENDING state; pending amber stays
on ground. Forms use square well fields: email values are mono, while organization names and selectors retain sans. Selectors use intrinsic width, bounded by the available width, so desktop destination controls and their actions stay inline and phone controls can wrap. Members use a 78ch reading measure; Organizations and Projects extend to 100ch. Removal and move decisions use inline
red-wash sign-off regions naming the grant being revoked. Phone layouts stack
identities and wrap full emails and repositories. Headings use the existing 1.6em sans scale. No page numbers are introduced.
The shared account menu links Builds and Members for every operator, with
Organizations and Projects in a separate “Super user” group for acknowledged super users. Theme follows navigation; “Sign out” is the final action.

## Do's and Don'ts

### Do:
- Do choose the palette for the active ground and preserve text contrast of at least 4.5:1.
- Do explain what an escalation means and what answering does.
- Do keep state words and step marks beside their color.
- Do keep destructive confirmation inline and show acknowledged durable state.

### Don't:
- Don’t place amber text on the inset well or red wash; use the plain ground.
- Don’t add shadows, gradients, pills, icon sets or emoji.
- Don’t replace the build page with a drawer, modal or in-place expansion.
- Don’t invent page numbers or decide a new app title; both remain human decisions.
