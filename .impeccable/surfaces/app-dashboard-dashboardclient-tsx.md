---
version: 1
slug: "app-dashboard-dashboardclient-tsx"
primary_target: "app/dashboard/DashboardClient.tsx"
related_targets: ["app/dashboard/BuildsView.tsx","app/sign-in/SignIn.tsx","app/layout.tsx","app/globals.css"]
---

# Operator web app

Scope: the whole operator web app (shell, Builds, sign-in). Mode: Operate.

Audience and job: the operator, glancing from a second monitor or a phone, sometimes with a teammate. One question: does anything need me? Signals in priority order: BLOCKED on a human, FAILED or unhealthy, PR READY or MERGED. Then act on one row, answer an escalation, or inspect a trail.

Content: live operator API data only. Loading shows a diagnostic, never zeros. Vocabulary is binding and matches SPEC.md and the terminal dashboard.

Constraints: keep the Builds API client, view-model, parity projection, event vocabulary, and control names. Presentation is free. Dark only. One monospace face loaded through next/font, a face engineers know from their terminals. Colors as tokens; contrast outranks palette strictness. Page numbers deliberately undecided.

Memorable moment: the bold one-row masthead carrying one imperative word.

## Direction contract

THESIS: The terminal frame, broadcast. The same rows, glyphs, and words on a black character grid; every color is a state; one header word says what needs a human. Refuses the ops console of sidebar, metric cards, and pill-status table.

OWN-WORLD: Black ground. One mono face and one natural-proportion size, with a bold one-row masthead. Teletext primaries as tokens: white identity, yellow title and warning, cyan current and live, green done and running, red blocked and failed, dim slack. Bracket glyphs [x] [>] [~] [ ]. A Fastext row of four fixed-color cells carrying key letters. No borders finer than a cell, no shadows, no gradients.

STORY: Glance, read one word, act on one row, leave.

FIRST VIEWPORT: One-row masthead, repository yellow left, imperative in its color, clock right. Control line with identity, sign out, and the repository selector when there is a choice. Dispatcher line with ON/OFF toggle words. Build rows: id at a fixed column, bold slug, right-pinned STATUS, step line beneath, detail unfolding in place. Harvest row. Sticky Fastext footer.

FORM: Teletext Dispatch, user-steered hybrid of grounded candidates 4 and 1, re-roll round 1; seed key 6c8eba83.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
