---
title: "Operator surfaces"
group: "reference"
description: "Watch and act through the terminal, CLI, local stdio MCP, or Operator API with your operator agent."
label: "Operator surfaces"
order: 12
---

# Operator surfaces

## Responsibility

Operator surfaces are where you and your operator agent inspect tickets and builds, answer escalations, pause work and authorize merge. Autobuild never hosts or starts your agent; it runs anywhere.

## Shipped arrangements

### Terminal dashboard and local CLI

A local Store needs no dashboard credential:

<!-- seam-config:start -->
```toml
[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

```sh
bun ab dispatch
bun ab builds
bun ab build status example-build --json
```

- Interactive `dispatch` shows the terminal dashboard.
- A shell-capable agent follows progress and acts through the CLI, including `bun ab watch` and `bun ab wait`.
- A standing CLI operator uses `bun ab watch --operator --json` after checking `bun ab repository status --json` for existing presence. It operates the builds the repository's dispatcher dispatches and adopts new ones.
- Presence is advisory and allows multiple registrations. MCP repository status marks it `unavailable`, which is not evidence of absence. Termination attempts withdrawal; routine timeout/count re-arms keep the five-minute grace. SIGKILL and failed withdrawal rely on TTL expiry.
- Dashboard and API share one lifecycle vocabulary.

When a leaf with an open pull request waits on the PR but has no landing decision for its current candidate, `ab build status <slug>` prints a `landing: undecided — <reason>` line, and `--json` includes an optional `landingUndecided` string. The reason names what is holding the decision back:

- an open session, a pause, a terminal state, an open escalation, or a pending pause or abort request;
- a compatibility deferral;
- a failed dispatcher janitor attempt, with its message and next attempt time;
- a latest build pipeline configuration the dispatcher cannot read, even when the build's verification pin is still readable;
- no recorded base for the merge candidate.

If none of these apply, the line says no refusal is recorded and the dispatcher decides at its next janitor poll. Repository-wide forge deferrals appear in `ab repository status`. When a decision is recorded for the current candidate, the line and the field are no longer shown.

A local CLI can use a remote Store:

<!-- seam-config:start -->
```toml
[store]
url = "https://builds.example.com"

[tickets]
source = "file"
readyState = "ready"
```
<!-- seam-config:end -->

`bun ab connect https://builds.example.com` approves the registered project and saves its credential outside the checkout; CI sets `AB_TOKEN` instead. It authorizes the project only, not forge or runtime access. See [Build store](build-store.md).

### Web UI (`ab web`)

```sh
bun ab web
```

- Read-only: it appends no event, takes no dispatcher lease and registers no operator presence.
- Binds `127.0.0.1` on a free port (`--port` picks one) and refuses requests whose Host is not loopback or the bound address.
- `--host <addr>` serves beyond loopback with no access control; `ab web` warns that anyone who can reach the port can read the repository's builds.
- `--json` prints one line, `{"url":"http://127.0.0.1:<port>/"}`, for agents that open or hand off the page.
- Reads nothing from the store while no browser is connected; open tabs share one refresh loop.
- While idle, each poll reads only the repository change position.
- A fresh process starts the overview from the build roster. It reads each live build plus each aborted build among the roster's 10 newest finished builds, to show aborts still cleaning up. An older abort still cleaning up appears at its next change. Startup never scans history.
- A build change reads that build only, plus one roster read when a build starts, finishes or aborts. The overview never lists builds, and nothing reads event history.
- A remote store server too old to serve the roster, the changed-builds feed or the filtered listing fails the read with a typed error instead of falling back.
- Pages:
  - The overview (`/`) shows the dispatcher's mode, capacity, what needs attention, and active, queued and recently finished builds. Each row links to its build page.
  - A build page (`/builds/<slug>`) shows an active or queued build's ticket, phase, steps and attention. A recently finished build's page shows only its outcome, kind and completion time, because the roster keeps no finished tickets. Every build page ends with that build's timeline, including builds the overview does not list.
  - Analytics (`/analytics`) shows the Gantt of builds and the step-duration table; see [Timeline and analytics](#timeline-and-analytics).
  - Pages update live and offer no actions.
- Analytics and timelines are explicit reads from `/api/analytics` and `/api/builds/<slug>/timeline`, never polled:
  - A page fetches on load and on every filter, window or page change. For the same query, it fetches again only when the change position moves.
  - Every request reads the change position. When the position has moved, it also reads the changed-builds feed, and the builds the feed names leave the in-memory timeline cache.
  - An analytics answer that is not in memory reads one rollup value, one listing page and at most 25 saved timelines (only the builds not in memory).
  - A build timeline that is not in memory reads the build and its saved timeline.

`ab dispatch --web` and `ab dispatch --viewer --web` serve the same UI from the dispatcher or viewer process:

- `--port`, `--host` and `--json` work as for `ab web` and require `--web`; `--json` changes only the URL announcement line.
- A TTY keeps the terminal dashboard. Under `--plain` or without a TTY, the web UI is the only presentation: stdout carries only the URL line, and warnings and diagnostics stay on stderr.
- Shows what the dispatcher's own refresh reads: the repository header without the overview. In plain mode the page updates each dispatcher tick (`--interval`, default 10 s).
- Frames from the terminal dashboard add no store reads. A plain dispatcher reads one change position per tick while a browser is connected, and nothing while none is.
- Analytics and build timelines work once the dispatcher's store is open, as explicit reads.
- Binds before the repository lease; a taken port fails dispatch before it claims anything.
- The URL keeps working across automatic runtime upgrades and is printed once. Ctrl-C closes it. `--once` is refused.

### Local stdio MCP

For an agent with an MCP client but no convenient shell, configure the client to launch:

```sh
bun ab mcp
```

- **Scope.** Run from the connected project, or pass `--store` and `--repo` to constrain authority.
- **Lifetime.** Serves the operator tool registry over stdio; exits on client EOF. No daemon.
- **Phase refusal.** Refuses phase-session `AB_*` authority, including malformed tuples: repository-wide tools can't be narrowed to one phase.
- **Attribution.** Sessionless writes use the local user identity, like the CLI.

## Writing your own

There's no operator-surface plugin map. Build a client of the versioned, authenticated Operator API, or launch local stdio MCP.

- One registry defines tools, schemas, annotations and execution, keeping CLI, API and MCP at parity.
- Follow the API's request, version and authentication requirements; don't scrape dashboard markup.
- A new surface adds no pipeline phase and no embedded operator agent.

[Writing a plugin](plugin-authoring.md) covers infrastructure adapters.


### Forge cooldown admission and explicit recovery

Hosted repository event appends and atomic artifact deposits validate
`dispatcher.forge-degraded` and `forge.credential-limited` before any durable
mutation. The payload must match its event schema, with a finite ISO `resetAt` at most 24 hours after server time
(inclusive). Already-expired deadlines are accepted. Invalid or out-of-horizon
writes return `400 validation` (the remote adapter exposes `EventValidationError`);
the server never clamps or invents a provider reset. Historical decoding has no clock-relative restriction.

Build-runner and build-phase grants may POST only the kernel-authored
`forge.credential-limited` and `dispatcher.forge-degraded` repository facts
through the events route. Current runners and phase sessions record only
`forge.credential-limited` attention; the `dispatcher.forge-degraded` exception
remains for runners pinned to older releases. The
preceding `requireProject` check binds this exception to the exact repository
in the delegated claim. A hosted project identifies one repository. Delegates
cannot write recovery, deposits or other repository facts, regardless of the
actor claimed in an envelope.

An authorized operator can explicitly clear erroneous state through
`repository.forge_clear {repo, forge, reason}` or
`ab repository forge-clear --forge <name> --reason <text> [--json] [--store <ref>]`.
The reason is required and nonblank. The result contains the durable recovery
`event`, attributed to the authenticated human with normal `via` attribution.
Build and harvest delegates cannot invoke this operator mutation. CLI use
requires an operator outside build/harvest sessions. This is an override, not
proof of provider success. A clear appends once without reading history, even
when already healthy; later degradation wins by ordinary journal order.
Existing dispatcher/kernel automatic recovery and old payloads remain valid;
the recovered payload additionally accepts an optional nonblank `reason`.

## Dispatcher ownership

Read `ab repository status --json` before starting a dispatcher. The shared
`dispatcherRunning` field (also in the `repository.status` operator tool) is true
when a holder, expired holder or unfinished handoff names a draining predecessor.
An empty drain map does not prove retirement. Missing or unreadable running
status fails closed: never start while running or while that fact is unknown.

`ab operator dispatcher --json` reads the checkout's preference; save a choice
with `ab operator dispatcher human` or `ab operator dispatcher agent`. The optional
`[operator] dispatcher = "human" | "agent"` lives only in `.autobuild/local.toml`;
no choice is assumed when unset. Even an empty `[operator]` is rejected in
`autobuild.toml`. Saving preserves other settings semantically and may normalize
TOML formatting. It needs no store or credential, writes no event, and is refused
inside build or harvest sessions. Reading a missing local file creates nothing.

Repository instructions take precedence. With none running, follow the saved
preference or ask who should run it and offer to save the answer. For human
ownership, give startup instructions and wait. For agent ownership, start
`ab dispatch --web --plain --json` under the harness's managed background lifetime
and give the person its URL. Stop only a dispatcher this session started, only
when requested, using a clean stop with drain. Never adopt, restart, kill or manage
another session's process; a preference does not authorize takeover.

`ab web [--json]` is always allowed, even while a dispatcher exists: it serves a
read-only UI without acquiring a dispatcher lease. `ab dispatch --web` serves the
same UI alongside dispatch; `--plain` keeps the URL on stdout and diagnostics on
stderr. Both default to loopback. Serving beyond loopback has no access control;
see [operator surfaces](operator-surfaces.md) for binding and refresh details.

## Timeline and analytics

The analytics page (`/analytics`) shows where build time goes. A window and two filters apply to both charts:

| Control | Choices |
|---|---|
| Window | 24 hours, 7 days (default), 30 days, all retained history (400 days) |
| Outcome | merged (default), all |
| Kind | leaf (default), node, all |

- **Gantt.** One row per build, coloured by phase and wait, 25 builds to a page, most recently active first. A page holds builds the store wrote to during the window, including writes that are not events, such as an artifact or a lease release. Newer and Older page through them.
- **Axis.** Clock aligns actual times across builds; from start aligns each build's start.
- **Rows.** A build expands into one row per segment. Hovering a segment, or focusing its bar, shows its step, round, build, start, end and duration.
- **Segments.** Repeated phase rounds stay separate segments, and parallel verify steps may overlap. Queued, ticket-wait, paused, escalated and awaiting-merge segments show waiting rather than execution. Open segments grow with the clock.
- **Step durations.** Steps in pipeline order, waits last. Per run shows the mean bar with P50, P90 and P99 markers; total time shows the summed time and its share. Totals reveal where work adds up; a slow run and a large total answer different questions.
- **Build timeline.** Each build page ends with the same chart for that build, expanded to its segments.

The window starts at UTC midnight of the first day it overlaps, the same day the step-duration rollup reads from.
