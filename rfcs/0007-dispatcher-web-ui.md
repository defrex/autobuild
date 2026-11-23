# RFC 0007 — Dispatcher web UI, build analytics and derived reducers

**Status:** proposed, 2026-11-23, and revised the same day with the
maintainer's first rulings (§14). Not decided design. `SPEC.md` describes the
running system until a ticket that builds a section of this RFC amends it.
Open questions are marked `[OPEN]` and collected in §15.

**Hat:** product. The web server, the `--web` flag, the `ab web` command,
derived reducers and the timing metrics built on them, the Autobuild ANSI
design system in `packages/ui`, and the operator guidance all ship to every
user. The design-system catalog page is a development surface of
`packages/ui`, not something `ab` serves. Capturing the new UI as verify
evidence for this repository is repository configuration and is separate work
(§16, ticket 8).

---

## 1. Problem

The local dispatcher has one presentation: the terminal dashboard. That fails
in three situations.

- **Agent-first environments have no terminal for the human.** Less technical
  users work from a desktop or cloud agent and don't want to juggle terminals.
  Today they must start and keep a dispatcher running themselves, because the
  operator skill forbids the agent from doing it, and they still can't see the
  dashboard from inside the agent.
- **Terminal users get no visual analysis.** The terminal dashboard shows the
  current state of builds. It can't show where time went across fifty builds,
  and a terminal is a poor place to draw that.
- **The hosted web app is the wrong tool for a local dispatcher.** It is a
  Next.js service with Better Auth, organizations and projects. Running it
  next to a local dispatcher means deploying a service for one repository.
  Its UI is also clunkier than the maintainer wants to keep building on.

Nothing in Autobuild answers "where is my time going?" either. The event log
holds the answer: every phase, wait, pause and escalation has timestamps.
Nobody can see it.

Answering it exposes a gap in how values are read. Saved reduced values today
cover one build's log or the repository's log. A metric across builds, such
as P90 plan time over the last week, has no saved form. Without one, the only
way to compute it is to read every build's history on every request, which
breaks the read-cost rules. The same gap blocks adopters from defining their
own metrics.

## 2. Summary

1. **One read-only web server, two ways to start it** (§4). `ab dispatch --web`
   serves it from the dispatcher process. `ab web` serves it on its own against
   whatever dispatcher runs for the repository. Both read the BuildStore only,
   so they are one code path. The port is any free port, or the one passed with
   `--port`.
2. **No access control, so loopback and read-only** (§5).
3. **Three views** (§6): the dispatcher overview, a build page, and analytics.
   Rows use the shared dashboard projection, so the web and terminal say the
   same thing.
4. **Two analytics charts first** (§7). A Gantt chart with one row per build,
   colored by phase and wait. A per-step duration chart showing the mean with
   P50, P90 and P99 markers, with a total-time mode.
5. **Derived reducers** (§8). A metric is defined as a per-build reducer plus
   a rollup that combines per-build contributions into a repository value.
   Each has its own saved key. The first computation may be expensive, and
   every later read advances only by what changed. The timing metrics are the
   first rollup. The same mechanism later opens to consumer code.
6. **No new runtime dependencies** (§10). The browser code is bundled ahead of
   time into a checked-in asset. React and Vercel's UI SDK are development
   dependencies only.
7. **Autobuild ANSI becomes an explicit design system** (§11). `packages/ui`
   holds the tokens as typed source, the components and the charts, plus a
   static catalog page showing all of them. The maintainer and an agent refine
   it on that page before any integration ticket is filed.
8. **Who runs the dispatcher is the human's preference** (§12). An operator
   agent detects a running dispatcher and never starts a second one. When none
   is running, it asks whether the human runs it or the agent does, and can
   save the answer.

## 3. Ontology

| Term | Meaning |
|---|---|
| Dispatcher web UI | The read-only web server and pages described here. |
| In-process mode | The server running inside `ab dispatch --web`. |
| Standalone mode | The server running as `ab web`, with no dispatcher in its process. |
| Segment | One span of a build's wall-clock time with one category: a phase occurrence or a wait. |
| Timeline | A build's ordered segments. |
| Step | A segment category the duration chart aggregates, such as `plan` or `verify:unit`. |
| Derived reducer | A metric definition: a build reducer, a contribution function and a rollup. |
| Contribution | What one build adds to a rollup, computed from that build's saved value. |
| Rollup | The saved repository value that sums the contributions of all absorbed builds. |
| Changed-builds feed | The store's answer to "which builds changed since position P", in cost proportional to the answer. |
| Dispatcher ownership | Whether the human or the operator agent starts and stops the dispatcher. |
| Catalog | The static page in `packages/ui` that shows every token, component and chart. |

## 4. Surfaces

### 4.1 `ab dispatch --web`

`ab dispatch` starts the server in its own process alongside its normal work.
The terminal dashboard still runs when there is a TTY. Under `--plain` or with
no TTY, the web UI is the only presentation, which is the agent-run case.

`--web` composes with the existing dispatch modes. `--viewer --web` serves the
web UI from a viewer of the hosted dispatcher. `ab web` (§4.2) is the plainer
way to get the same thing.

### 4.2 `ab web`

`ab web` starts only the server. It does not dispatch, take the lease, or
register operator presence. It reads the repository's configured store the way
`ab watch` does, and it serves whatever dispatcher runs for the repository,
local or hosted.

### 4.3 Port, bind and announcement

- `--port <n>` binds that port and fails if it is taken. Without it, the
  server binds any free port the OS assigns.
- `--host <addr>` widens the bind from `127.0.0.1` (§5).
- When it is listening, the server prints its URL once. With `--json`, it
  prints one line, `{"url": "http://127.0.0.1:<port>/"}`, so an agent can pick
  it up and hand it to the human. `ab dispatch` has no `--json` today; it gains
  one that is valid only with `--web` and changes only this line.
- Nothing here knows about particular sandboxes. An agent in an environment
  that forwards only certain ports passes `--port` and `--host` to suit it. The
  UI works wherever the environment lets the human reach the port.
- The URL is not written to the store. It is a local process fact, and in a
  hosted store a loopback URL means nothing to anyone else.

### 4.4 Why both modes share one code path

Core rule 5 says processes communicate only through durable state. The server
therefore reads the store even when it runs inside the dispatcher, never the
dispatcher's memory. In-process mode can reuse the dispatcher's existing
refresh loop and repository feed (§9.3), which already read the store. That
saves reads without creating a private channel.

## 5. Exposure and safety

There is no access control, so v1 limits exposure:

- **Loopback by default.** `--host` widens the bind and prints a warning that
  anyone who can reach the port can read the repository's builds.
- **Read-only.** No pause, abort, answer, merge consent or ticket moves. Those
  need an access story first (§17).
- **Host header check.** Requests whose `Host` is not the bound address,
  `localhost` or `127.0.0.1` are refused, unless `--host` widened the bind.
  This blocks DNS rebinding against a loopback server, at almost no cost.
- **Self-contained page.** `Content-Security-Policy: default-src 'self'`. The
  page makes no third-party requests, so it works offline and in sandboxes with
  restricted egress. Fonts ship in the bundle.
- **No transcripts and no credentials.** The pages show what the terminal
  dashboard shows. Ticket bodies and escalation text appear, so the bind
  warning matters.

## 6. Views

The web UI serves one repository and one dispatcher. It has no project
picker, organization pages or sign-in.

1. **Overview** (home). Dispatcher state (running, viewer, stopped, upgrade
   handoff), capacity, items that need attention, and the active, queued and
   recently finished builds. Rows come from the shared projection under
   `packages/core/src/cli/dashboard/`.
2. **Build.** One build's header, ticket, current phase, attention, and its
   own timeline: the single-row form of the Gantt (§7.1), larger and with
   segment detail.
3. **Analytics.** The Gantt chart and the step-duration chart, with a time
   window and filters (§7.3).

**Parity:** a change to what a row says belongs in the shared projection,
never in the web UI alone. Presentation may differ from the terminal; the
vocabulary may not.

## 7. Analytics

The first goal is to show where time goes.

### 7.1 Gantt chart

- One row per build, newest first, paged (25 rows to a page).
- The x-axis is wall-clock time across the selected window. Rows can switch to
  a relative axis, where every build starts at zero, so durations line up.
- Each segment is colored by category. Agent phases get strong colors and
  waits get muted ones. The palette is a design-system decision (§11).
- Phases that repeat, such as plan and review rounds or implement and
  code-review rounds, appear as repeated segments. Retry loops are visible
  without extra work.
- Segments that overlap, such as verify steps running in parallel, are stacked
  in thin sub-lanes inside the row.
- A live build's open segment grows with the clock.
- Hovering or focusing a segment shows its category, start, duration and round.
  Clicking a row opens the build page.

### 7.2 Step-duration chart

- One bar per step, sorted by the measure shown.
- **Per-run mode** (default): the bar's length is the mean duration of one
  occurrence. Markers show P50, P90 and P99, and the count is labeled.
- **Total mode**: the bar's length is the total time spent in the step across
  the window, which is mean times count. This is the "where did the hours go"
  view. A step that is quick but repeats often, like implement retries, can
  dominate it.
- Waits are steps too, so queue time and escalation time are measured like
  plan time.

### 7.3 Window and filters

- Window: 24 hours, 7 days (default), 30 days, or all retained history.
- Outcome: merged only (default), or all builds including aborted ones.
- Kind: leaf builds (default). Node and optimization-attempt builds have
  different shapes (`[OPEN]` Q4).

### 7.4 Segment taxonomy

Phase segments come from the same start and terminal events that
`dashboardFactsReducer` already pairs (`facts.ts`, `foldInterval`).

| Category | Opens | Closes |
|---|---|---|
| `plan`, `plan-review`, `implement`, `code-review` | `*.started` | `plan.completed`, `*.verdict`, `implement.completed` |
| `verify:<step>` | `verify.started` | `verify.completed`, `verify.cancelled` |
| `finalize` | `finalize.started` | `finalize.completed` |
| `reconcile` | `reconcile.started` | `reconcile.completed` |
| `queued` (wait) | `build.created` | first `execution.started` |
| `escalated` (wait) | `escalation.raised` | `escalation.answered` |
| `paused` (wait) | `build.paused` | `build.resumed` |
| `ticket-wait` (wait) | `wait.entered` | `wait.ended` |
| `awaiting-merge` (wait) | `pr.opened` or `finalize.completed` | `pr.merged`, `pr.closed`, terminal |

Rules:

- Any gap not covered by a segment is `idle` and drawn as background. The
  duration chart doesn't count it.
- A second `*.started` while one is open replaces the open start, matching
  `foldInterval`. A crashed cross-sandbox attempt contributes nothing.
- Wait segments may overlap phase segments. An escalation raised during
  implement is both. The Gantt shows both; the duration chart counts each in
  its own step.
- These names are vocabulary. They live in the shared projection, and the
  terminal dashboard may use them later.

`SPEC.md` gains a section defining segments and steps when ticket 2 lands.

## 8. Derived reducers

### 8.1 How saved values work today

Reduced values are cached per **scope**, and a scope is one log: a build's
log (`{kind: 'build', slug}`) or the repository journal (`{kind: 'repo',
repo}`) (`store/snapshots.ts`). There are two caches.

- **Named values** (`getReducerValue`, `store/reducer-values.ts`). The
  request names a reducer from the compiled registry (`REDUCERS` in
  `kernel/reducer-registry.ts`) plus optional arguments. The store keys the
  saved accumulator by a hash of scope, reducer name, reducer version, read
  catalog identity and arguments (`value.v2.<hash>`). It stores the
  accumulator with the cursor (the highest event seq folded in). A read loads
  the saved accumulator, folds only the events after the cursor, saves it and
  returns the finished value. A missing or stale key is reduced from the log
  once and then saved. Only the store adapter writes these rows. Remote
  clients cannot submit an accumulator, which is what makes the server's
  value canonical.
- **Public snapshots** (`getReducerSnapshot` and `putReducerSnapshot`). This
  is a client-writable cache beside the log, keyed by scope, name and version,
  and never authoritative. Clients compute an accumulator and store it here.
  The dispatcher's repository feed does this today
  (`cli/dispatch-repository-feed.ts`).

A reducer's version comes from its identity's revision ledger. Changing a
fold bumps the version, which gives it a fresh key, so the value is reduced
once more and then saved again.

So the mechanism the maintainer proposed already exists in one dimension:
a named reducer with arguments gets its own key, and the first read pays for
the full reduction exactly once. What is missing is a scope that spans builds.

### 8.2 The shape of a derived reducer

A metric across builds is defined in three parts:

1. **A build reducer.** An ordinary incremental reducer over one build's log,
   saved per build as a named value. For timing, this is `buildTimeline`, the
   segments of §7.4.
2. **A contribution function.** A pure function from the build reducer's
   finished value to that build's share of the rollup. For timing, this is
   each segment's duration, added to the histogram for its step and the UTC
   day it ended.
3. **A rollup.** A repository-scope accumulator with an identity, an `add`
   and a `subtract`. Its value is the sum of the contributions of every build
   it has absorbed.

**Contributions must be invertible.** A rollup has to subtract a build's old
contribution when that build changes again: a live build gets a new closed
segment, or a settled build is reopened. Counts, sums and histograms invert.
Minimum and maximum don't, so a rollup expresses them through histograms.
This one rule lets a rollup absorb live builds as they change instead of
waiting for them to settle, and it keeps reopened builds correct.

### 8.3 How a rollup advances

The rollup's saved state is its accumulator plus a **feed position**. A read
does this:

1. Compare the repository's change position with the saved one. If they are
   equal, return the saved value: no event rows and no feed query. Otherwise
   ask the changed-builds feed for builds whose logs changed since the saved
   position (§8.4). The answer can be empty, because repository events and
   lease changes move the position too; then only the position is saved.
2. For each changed build, read its build reducer's saved value. That read
   advances by delta as usual.
3. Read the build's **absorbed contribution**: the contribution the rollup
   last added for it. It is new store-managed storage in the build's scope,
   keyed by rollup key, so it is one constant-size read.
4. Subtract the old contribution, add the new one, and commit the new absorbed
   contributions, the rollup accumulator and its new position together.

Every advance, not only the first, is serialized per rollup key, and the
commit is atomic. Two readers advancing the same rollup at once would
otherwise subtract or add a build twice, and a crash between saving a
contribution and saving the rollup would leave them disagreeing. The commit
is conditional on the position it started from; a reader that loses the race
returns the winner's value.

The cost per read is proportional to the number of builds that changed, never
to total builds or total events. Storage is one small row per build per
rollup key, and reading the rollup never touches those rows unless the build
changed.

**First computation.** A rollup with no saved value for its key, because it
is new or its version changed, absorbs every build once. For a build whose
reducer value is already saved, that is one value read. Otherwise the build's
log is reduced once and saved. This is the once-per-key reduction the rules
allow. It is serialized per key so concurrent readers don't duplicate it, and
saved durably so it never repeats.

### 8.4 The changed-builds feed

`[OPEN]` Q2. The store already has `getRepoChangePosition`, a repository-wide
position that advances with every build event and build creation. Its
contract allows only equality checks, so it can say "nothing changed" but not
"what changed".

Proposed: positions become ordered, a contract change every adapter must
already meet or be made to meet. The store also records, for each build, the
change position of its latest event, written in the same transaction as the
event. A new store method,
`listBuildsChangedSince(repo, position)`, returns the slugs whose latest
position is above the argument, in cost proportional to the result. The
shared store contract suite (`store/contract.ts`) and the remote protocol gain
it, and every adapter implements it.

Rejected alternative: mirror each build's terminal event into the repository
journal so a repository reducer could see it. The two writes are not atomic,
so a crash between them loses the mirror. It also only reports settled builds,
not live ones.

### 8.5 Where derived reducers run

- **Local stores:** in the process that reads them, through the store
  adapter, like named values today.
- **Remote stores:** on the server, through `getReducerValue` with a new scope
  kind, `{kind: 'rollup', repo}`. The server's rollup value is canonical. A
  client never rebuilds it from events or from build values, and a version
  mismatch fails with the existing typed error.
- **Two kinds of arguments.** Today every `getReducerValue` argument is part
  of the key. A rollup request adds read-time arguments, such as the window
  in §8.6, which shape the finished value without creating a new key. The
  request schema and the remote protocol gain that distinction.

Product rollups are registered in the reducer registry and versioned through
the revision ledger, like any reducer.

### 8.6 Timing metrics: the first rollup

- **Build reducer:** `buildTimeline`. It holds a bounded list of segments.
  Past a cap, for example 200, segments merge into their neighbors of the
  same category, so a pathological retry loop can't grow it without limit.
- **Contribution:** per segment, its duration added to the histogram for
  `(step, UTC day it ended)`. Open segments contribute nothing until they
  close.
- **Rollup:** `stepDurations`. Histograms use fixed log-scale buckets 10%
  wide from 1 second to 7 days, about 140 buckets, so a percentile is within
  about 5%. Buckets are stored sparsely. Each keeps a count and a sum, so
  means are exact and percentiles come from merged buckets.
- **Reading a window:** the window is a read-time argument, applied when the
  store finishes the value, and not part of the rollup key. The store merges
  the days in the window and returns steps × buckets, whatever the window.
  The read touches no events, and the response doesn't grow with retained
  history.
- **Retention:** days older than the cap (`[OPEN]` Q6) are dropped from the
  rollup. A later reopen of a build from a dropped day subtracts nothing for
  that day.
- **Filters:** outcome and kind filters (§7.3) are key arguments, so each
  filter combination is its own rollup with its own accumulator. The set is
  fixed and small. With the merged-only filter, a build contributes nothing
  until it merges, then contributes everything at once.

### 8.7 Consumer-defined metrics

The same three-part shape is what an adopter needs to define their own
metrics, such as review rounds per build, verify failure rate by step, or
time-to-merge by ticket label. Proposed direction, built after the timing
metrics prove the mechanism (§16, stage 4):

- The plugin SDK exports `defineBuildReducer` and `defineRollup`. A
  repository registers them from a local module named in `autobuild.toml`,
  the way plugin modules are loaded today.
- A consumer reducer's identity is its name plus a declared version plus a
  hash of its module source. Editing the code gives it a new key, so it is
  reduced once more and saved. Consumers don't need the product's revision
  ledger.
- Consumer reducers live in a separate namespace and never feed kernel
  decisions.
- **Local stores** run them in-process, with no new trust problem.
- **Remote stores** can't run consumer code on a shared server. `[OPEN]` Q3.
  Proposed: the client computes the value and stores it in a consumer
  namespace of the client-writable snapshot cache, under a store-side lease
  so the first computation is serialized across processes. That is allowed
  because the server never answers these values, so there is no server answer
  for the client to rebuild. Each first computation is still once per key and
  saved, and every later read is a delta.
- The web UI gets a generic chart surface for consumer rollups that return a
  declared shape, such as histograms by step or counts by day, so a consumer
  metric shows up without UI code.

## 9. Read cost on recurring paths

This section is the design's main constraint (CLAUDE.md, "Store read cost is
a correctness property"). Every recurring read below costs the same at 100
events as at 100,000 and reads zero event rows while nothing changes. Each
ticket's plan names every recurring read it adds, with its cost and frequency.

### 9.1 Duration chart

One rollup read per request. §8.3 bounds it: zero event rows when no build
changed, otherwise work proportional to the changed builds.

### 9.2 Gantt rows

A Gantt page reads the 25 `buildTimeline` values for its rows. Settled rows
come from the server's memory after the first read, keyed by slug and cursor.
On a live refresh, only rows whose builds changed, according to the
changed-builds feed, are read again, and only by delta.

Choosing which builds belong on a page needs an ordered, paged build listing.
`listBuildsForRepo` returns every record. It reads no event rows, but its cost
grows with build count. Ticket 1 adds a paged listing, ordered by creation,
alongside the changed-builds feed.

### 9.3 One poll for all tabs

- The server runs one refresh loop and holds the current overview model in
  memory. Browsers subscribe over server-sent events and receive the model as
  it changes. Ten open tabs cost the same store reads as one.
- In in-process mode the loop is the dispatcher's existing `DashboardRefresh`
  and repository feed. Turning on `--web` adds no store reads to the live
  views.
- In standalone mode the loop costs the same as `ab dispatch --viewer`, and
  it runs only while at least one tab is connected. An idle `ab web` with no
  tabs reads nothing.
- The browser never triggers a store read on a timer. Page navigation and
  analytics requests are explicit reads, served from the rollup and the
  timeline memory.

### 9.4 Proof

The read-budget harnesses in `packages/core/src/testing/`
(`reduced-read-budget.ts`, `dispatch-read-budget.ts`) are extended, not
duplicated, to show:

- zero event rows per rollup read while no build changes;
- work per rollup read proportional to changed builds, flat as history grows;
- one full reduction per build per rollup key, ever, including across a
  fresh process;
- live web views adding no store reads beyond the dispatcher's own refresh
  loop.

## 10. Packaging and dependencies

`@defrex/autobuild` publishes TypeScript source with no build step, and every
runtime dependency is copied into each hot-upgrade runtime snapshot
(`dispatch-runtime-dependencies.ts`). Every runtime dependency therefore costs
every user, every upgrade.

| Option | Runtime dependencies added | Verdict |
|---|---|---|
| Next.js app, like the hosted service | Next, React, many more | Rejected: a framework server inside the dispatcher. |
| `Bun.serve` with HTML imports, bundled at startup | React, UI SDK | Rejected: bundles on every start, adds packages to every install and snapshot. |
| Server-rendered HTML, hand-written script | None | Rejected: rebuilds focus, keyboard and popover handling by hand; that clunkiness is what the maintainer wants to leave behind. |
| **`Bun.serve` serving a bundle built ahead of time** | **None** | **Chosen.** |

How the chosen option works:

- **Server:** `packages/core/src/web/` uses `Bun.serve` with no new imports.
  It serves static assets, JSON for page reads, and one server-sent event
  stream.
- **Client:** an entry point built with `Bun.build` from `packages/ui` and the
  app's views. The output is committed as a generated file under
  `packages/core/src/web/assets/`. Committing it keeps it in the published
  source tree and in every source-mode runtime with no build step. A freshness
  check fails verify when the committed bundle is stale, like the docs
  baseline does.
- **Dependencies:** React 19, `@ui-sdk/core` and `@ui-sdk/react` become root
  `devDependencies`. The package's `dependencies` list does not change, and a
  test asserts it.
- **Size budget:** a test fails when the gzipped bundle exceeds a budget,
  proposed at 250 KB and settled in the design round.
- **UI SDK risk:** UI SDK is in beta (0.1.0-beta, Apache-2.0, React 19 or
  later), and its APIs may change before general availability. Pinning an
  exact version inside a prebuilt bundle contains that: an upgrade is a
  deliberate rebuild, and users never resolve a version. If UI SDK is
  abandoned, the bundle keeps working and `packages/ui` swaps the dependency
  behind its own component API.
- **Charts:** our own SVG components in `packages/ui`. Most chart libraries
  don't offer a Gantt chart, and both charts are small. Owning them keeps them
  in the design system and out of the bundle budget.

## 11. Design system: Autobuild ANSI

### 11.1 Starting point and goal

The system keeps the name **Autobuild ANSI** and starts from the recorded
world in `DESIGN.md`: state colors on two calm grounds, Atkinson Hyperlegible
Next for human language, JetBrains Mono for machine text, square corners and
no shadows. The goal is to refine it and make it explicit in code, rather
than relying on a prose document that each surface interprets on its own.

### 11.2 Source of truth

- **Tokens are typed source** in `packages/ui/src/tokens.ts`: colors for both
  grounds, the type ramp, spacing, rules, motion, and the segment palette
  (§7.4). Agent phases and waits must read as two families, and every color
  must hold contrast on both grounds, which a test checks.
- **CSS custom properties are generated** from the token source. So are the
  token front matter of `DESIGN.md` and its `.impeccable/design.json`
  sidecar. A freshness check fails when any of them is stale, so the documents
  can't drift from the code.
- **`DESIGN.md` keeps the prose rules**: what each component is for, the do's
  and don'ts, and the named rules. Token values in it are generated, never
  hand-written. It stays the single design authority, now backed by code.
- **The catalog is the visual specification.** If the catalog and the prose
  disagree, that is a bug to fix in one commit.

### 11.3 Contents of `packages/ui`

A private workspace package, not published on its own:

- **Primitives:** button, word action, field, menu, tabs, dialog, tooltip,
  list and table rows, state badge, and empty, loading and error states.
  Behavior (focus, keyboard, dismissal, popups) comes from UI SDK. Styling is
  ours.
- **Composites:** build row (rendered from shared-projection fixtures),
  dispatcher status strip, attention callout, page shell.
- **Charts:** Gantt row and chart, step-duration bar with percentile markers,
  axis, legend, segment tooltip.

### 11.4 The catalog page

`bun run ui:catalog` builds a static page into `.ab/ui-catalog/` (ignored)
showing:

- every token, as swatches, a type ramp and a spacing scale, on both grounds
  side by side;
- every primitive in each state: rest, hover, focus, active, disabled, error;
- every composite with realistic fixtures, including long titles, many
  attention items and empty lists;
- the charts with fixture data: three builds, eighty builds, parallel verify
  overlap, a live open segment, a build stuck in an escalation, and a skewed
  distribution where P99 is far from P50.

The fixtures come from the scripted dispatch models the existing capture
tooling uses, so the catalog shows real shapes, not placeholder text.

### 11.5 How it gets decided

`CLAUDE.md` makes a visual world a human decision, so the system is refined
interactively in a session with the maintainer, using the `impeccable` skill
against the catalog page. It is never built in an unattended build. The round
ends when the maintainer signs off on the catalog. Then the integration
tickets are filed (§16).

Moving the hosted web app's `globals.css` onto the generated tokens is out of
scope (§17). Until it moves, the hosted app is a second consumer of
`DESIGN.md`'s prose, and the generated front matter tells it which values to
match.

## 12. Dispatcher ownership and operator guidance

### 12.1 Ownership is a preference

Some people prefer to run the dispatcher themselves: they get the terminal
dashboard and keep their processes organized. Others work entirely from a
desktop or cloud agent and find separate dispatcher processes a burden. Both
are legitimate, so the operator skill stops prescribing one answer. It
enforces one hard rule and asks about the rest.

**The hard rule:** an operator agent never starts a dispatcher while one is
already running for the repository, whoever started it.

### 12.2 Detection

Before starting a dispatcher, the agent reads `ab repository status --json`.
A dispatcher counts as running when any of these holds:

- `dispatcher.holder` is present;
- `dispatcher.expiredHolder` is present (an expired lease whose run never
  recorded a stop may still be draining);
- `upgradeStatus.handoff` names a predecessor that is still draining.

If the status can't be read, the agent assumes a dispatcher is running and
does not start one. `[OPEN]` Q7: whether `ab repository status` should also
report a single `dispatcherRunning` field computed from these, so every
harness applies the same rule.

When a dispatcher is running, the agent operates through it as today. If the
human wants the web UI, the agent starts `ab web`, which is always allowed
because it is read-only and takes no lease.

### 12.3 When none is running

The agent asks the human which they prefer:

- **They run it.** The agent says how to start it (`ab dispatch`, optionally
  with `--web`) and waits.
- **The agent runs it.** The agent starts `ab dispatch --web --plain --json`
  (§4.3) as a background process its harness keeps alive, gives the human the URL,
  and operates as usual. It stops that dispatcher only when the human asks,
  and only with a clean stop. If the session ends abruptly, the lease expires
  and durable state resumes under the next dispatcher, as it does after any
  crash.

The agent offers to save the answer, so it asks once. The preference is
per person, never committed repository configuration, because two people on
one repository can prefer different answers. It lives in **local
configuration**: a per-person, uncommitted override layer over
`autobuild.toml`, which is general work tracked as its own ticket outside
this RFC (`[OPEN]` Q5). The setting is `[operator] dispatcher = "human" |
"agent"`, read and written through `ab`, so every harness sees the same
answer. In ephemeral environments where local files don't persist, the agent
asks again, or the human records the preference in their harness's own
instructions.

### 12.4 Documentation changes

- **`ab-operate`:** the Boundaries rule "never start, restart, or stop a
  dispatcher" is replaced by §12.1 to §12.3. Restarting a dispatcher the
  human runs, and managing any dispatcher process the agent didn't start,
  stay forbidden. Diagnosis guidance is unchanged.
- **`ab-guide`:** the new surfaces, derived reducers, the segment vocabulary,
  and how to read the two charts.
- **Docs:** `docs/operator-surfaces.md`, `docs/dispatcher.md`, `docs/cli.md`,
  and a docs page on derived reducers when consumer metrics ship. A one-line
  README mention with a link, only if the analytics screenshot earns a place
  in the pitch.
- **This repository's `CLAUDE.md`** keeps its self-hosting rule: the
  maintainer runs this repository's source-mode dispatcher. In product terms
  that is the "human" preference, stated as a repository rule.

Every passage in `skills/` that says agents never run `ab dispatch` is revised
in the same commit, across all three skill copies.

## 13. Events

No new event types. Segments and rollups are derived from existing events.
The changed-builds feed (§8.4) is store bookkeeping beside the log, like
`getRepoChangePosition`, not an event. The server records nothing about
itself in the store. If v2 adds write actions, they go through the existing
typed control paths and events.

## 14. Decisions

From the maintainer, 2026-11-23:

1. The web UI is built into the standard dispatcher, behind a flag.
2. It can also run without a dispatcher in its process, against the running
   dispatcher, so terminal users can open it for the visualizations.
3. It serves one repository and its dispatcher. No multi-project features.
4. No built-in access control.
5. The port is any free port, or the one given with `--port`. The RFC takes
   no position on particular sandbox environments.
6. Dependency-light. The trade-off is assessed in §10: no new runtime
   dependencies, with development dependencies bundled ahead of time.
7. The design system is built on Vercel's UI SDK in its own package. It keeps
   the Autobuild ANSI name and starts from the current design, made explicit
   in code instead of resting on `DESIGN.md` alone.
8. The design system is settled interactively on a static catalog page before
   integration tickets are filed.
9. Analytics starts with where the time goes: a Gantt chart with one row per
   build, colored by step, and a per-step duration chart with mean and
   percentile markers.
10. Cross-build metrics are custom reducers with their own saved keys:
    possibly expensive the first time, cheap after, and eventually definable
    by consumer code.
11. Dispatcher ownership is a personal preference. The operator skill gets
    lighter: it never starts a second dispatcher, and when none is running it
    offers to run one and to save the preference.

## 15. Open questions

| # | Question | Proposed answer |
|---|---|---|
| Q1 | Token source format. | `packages/ui/src/tokens.ts`, generating CSS and `DESIGN.md` front matter. |
| Q2 | The changed-builds feed. | Per-build change position and `listBuildsChangedSince` (§8.4). |
| Q3 | Consumer rollups against remote stores. | Client-computed, stored in a consumer snapshot namespace under a lease (§8.7). |
| Q4 | Node and optimization-attempt builds in analytics. | Excluded from the duration chart by default; shown in the Gantt behind a filter. |
| Q5 | Local configuration, which holds the dispatcher-ownership preference. | A separate ticket for a general per-person override layer; ticket 7 is blocked on it (§12.3). |
| Q6 | Rollup retention. | 400 days of daily histograms. |
| Q7 | A single "dispatcher running" field in repository status. | Yes, computed from the §12.2 conditions. |

## 16. Delivery plan

**Stage 1: this RFC.** Accept it, rule on §15, or defer items to the design
round.

**Stage 2: Autobuild ANSI, interactively.** Scaffold `packages/ui`: typed
tokens with their generators, the primitives, the chart components with
fixtures, and the catalog build. Iterate with the maintainer on the catalog
until sign-off. This lands by hand on a branch, not through builds.

**Stage 3: integration, as one node ticket with these children.**

1. **Changed-builds feed and paged listing.** The store contract, all
   adapters, and the remote protocol (§8.4, §9.2).
2. **Derived reducers and timing metrics.** The rollup scope, absorbed
   contributions, serialized first computation, `buildTimeline`,
   `stepDurations`, read-budget harness extensions, and the `SPEC.md`
   sections on derived reducers and segments. Blocked on 1.
3. **Web server core.** `packages/core/src/web/`: `Bun.serve`, the loopback
   bind, the Host check, CSP, the server-sent event stream, the committed
   bundle with its freshness and size checks, the dependency-list test, and
   `ab web`.
4. **In-process mode.** `ab dispatch --web`, sharing the dispatcher's refresh
   loop. Blocked on 3.
5. **Overview and build views,** on the shared projection. Blocked on 3.
6. **Analytics views.** Gantt and step-duration, with window and filters.
   Blocked on 2 and 3.
7. **Dispatcher ownership and guidance.** The repository-status field (Q7),
   the preference setting (Q5), the `ab-operate` rewrite, `ab-guide`, and docs
   (§12). Blocked on 4 and on the local-configuration ticket.
8. **Repository configuration (this repository's hat).** Extend the
   web-capture tooling and the `ui-app` verify path, or add a sibling step, so
   builds that touch `packages/ui` or `packages/core/src/web/` produce
   screenshot evidence. Blocked on 5.

**Stage 4: consumer-defined metrics.** The plugin SDK surface, module
loading, the consumer namespace, the remote-store path (Q3), and the generic
chart surface (§8.7). Filed as its own node once stage 3 has proven the
mechanism on the timing metrics.

## 17. Deferred

- Write actions (answer, pause, resume, abort, merge consent, ticket moves).
  They need an access story first, such as a per-run token printed with the
  URL.
- Moving the hosted web app onto `packages/ui` and the generated tokens.
- More built-in analytics: throughput, lead time, review rounds per build,
  verify failure rates, agent time versus wall-clock time from session
  brackets, and cost and tokens per step.
- Transcript viewing.
- Multiple repositories in one server.
- Recording the served URL in the store.

## 18. Alternatives considered

- **Extend the hosted web app and run it locally.** It brings Next.js, Better
  Auth, Postgres assumptions and multi-project routing into a single-repository
  local tool. Rejected for weight. Its clunkiness is also a reason to start the
  design system fresh.
- **Build analytics into the terminal dashboard only.** A terminal can draw a
  coarse Gantt chart, but not one an agent can hand to a human who isn't
  using a terminal. The segment vocabulary stays shared, so the terminal can
  adopt it later.
- **Compute analytics in the browser or client from events.** Forbidden:
  clients never rebuild server state from the event log, and it would read
  the full history on every page load.
- **Record per-build summaries as events.** Events record facts, never
  derived state, and a summary would need re-recording whenever its
  definition changes.
- **Rollups that absorb only settled builds, with merge but no subtract.**
  Simpler, but a reopened build would leave its old contribution in place,
  and live builds would be invisible until they settle.
- **Adopt shadcn/ui components.** shadcn is a copy-in component kit with its
  own look, built on Radix or Base UI. UI SDK sits lower, as behaviors with no
  styling, which suits a design system with its own world.

## Evidence

- Saved-value caches: `packages/core/src/store/reducer-values.ts`
  (`resolveReducerValue`, `readReducerValue`),
  `packages/core/src/store/snapshots.ts` (`SnapshotScope`, public snapshots).
- Reducer registry and versions: `packages/core/src/kernel/reducer-registry.ts`,
  `packages/core/src/kernel/incremental.ts`.
- Repository change position: `BuildStore.getRepoChangePosition` in
  `packages/core/src/store/types.ts`.
- Client-written snapshots in use: `packages/core/src/cli/dispatch-repository-feed.ts`.
- Existing per-build phase pairing: `packages/core/src/cli/dashboard/facts.ts`
  (`foldInterval`, `dashboardFactsReducer`).
- Read-budget harnesses: `packages/core/src/testing/reduced-read-budget.ts`,
  `packages/core/src/testing/dispatch-read-budget.ts`.
- Runtime dependency snapshots:
  `packages/core/src/cli/dispatch-runtime-dependencies.ts`.
- Current operator boundary: `skills/operate/SKILL.md`, Boundaries ("Never
  start, restart, or stop a dispatcher").
- Recorded visual world: `DESIGN.md` (Autobuild ANSI).
- UI SDK: https://github.com/vercel-labs/ui and
  https://infoq.com/news/2026/11/vercel-ui-sdk (beta 0.1.0-beta.1,
  Apache-2.0, React 19 or later; unstyled parts exposing attributes and CSS
  variables).
