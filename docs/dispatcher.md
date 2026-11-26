---
title: "The dispatcher and durable state"
group: "concepts"
description: "How Autobuild claims ready tickets, runs isolated builds within capacity, and resumes from its event log."
label: "Dispatcher"
order: 3
---

# The dispatcher and durable state

The dispatcher is the long-running process that turns ready tickets into builds. Agents supply judgment inside the pipeline; deterministic code decides what runs next.

```
bun ab dispatch
```

It watches your ticket source, claims eligible tickets, pins their specs, and starts isolated build-runners up to capacity.


## Watch a dispatcher running elsewhere

A human can open the terminal dashboard from a local checkout without dispatching:

```sh
bun ab dispatch --viewer --dispatched-by app.autobuild.run
```

The optional label is descriptive input. Every frame says `viewer · dispatched by
<label>`, or simply `viewer` when omitted. Plain/non-TTY output states the mode
at startup and prints state changes. With `--web`, a TTY viewer shows the web UI's
URL at the right of its `viewer` line, and plain/non-TTY output prints only the URL
and the web UI is the presentation. `--once` reads one snapshot; `--interval <s>`
sets the polling cadence. Without a recorded configuration it waits for the dispatcher.

The viewer takes no repository lease and starts no build, harvest, scan, janitor,
or dispatcher process. Ctrl-C closes only the viewer. Shared-store controls
remain available: merge consent, hold, pause/resume, blocked feedback/retry,
intake and harvest gates, harvest resume/acknowledgement, queued discard and
confirmed abort. Navigation and session inspection work as usual. These record
operator intent for the dispatcher to execute. No current control needs a local
dispatcher. Startup intake flags and `--repository` are rejected; use a local
checkout with its configured Store or `--store`. Operator agents follow the
[dispatcher ownership boundaries](#dispatcher-ownership) for startup and process
management; `ab web` is always available for read-only viewing.

## Ready work becomes a build

A ticket is claimed when it passes every gate:

- **Ready state.** The configured workflow state, plus, for ordinary intake, the required labels and source-specific listing filters such as the ready assignee.
- **Blockers.** Every dependency is done.
- **Destination.** Its target (`main` or an integration node) accepts new work.

Others stay queued. Urgent tickets are claimed before normal ones, each in the source's order; priority never preempts a running build. With `[policy].maxOpenPrs` set, open-PR backpressure pauses new normal-priority claims while that many root PRs are open and unmerged, until the count drains to `resumeOpenPrs` (below `maxOpenPrs` when the two are equal); urgent claims and in-flight work continue. See [`[policy]`](configuration.md#policy). See [Tickets and specs](tickets.md) for grooming and [Intake and harvest](intake.md) for proposed work.

To start one ticket without turning intake on for the whole ready queue, run `ab start <ticket-id> [--priority manual|urgent|normal]` (or the `tickets.start` operator tool). The running dispatcher, local or hosted, claims just that ticket on its next tick with a free slot in the request's tier and records the outcome as a `ticket.start-settled` event shown by `ab watch` and `ab repository status`. The default `manual` tier goes ahead of all waiting work; `urgent` and `normal` wait their turn as described below. The ticket must still be in the ready state, meet the spec standard, have no unresolved blockers and a destination that accepts work, and is deduplicated against existing builds; capacity and repository pause still apply. Listing labels and the ready assignee are not applied, because the ticket is named. Every tier bypasses intake off and open-PR backpressure for that ticket only. See `ab help start`.

Each build gets its own workspace (local git worktree or remote sandbox) and a build-runner that owns its pipeline. Capacity is the repository's number of slots. A build takes a slot only by admission (a ticket claim, a start request or an admitted slot request) and holds it while Autobuild owes its next move, runner or not: between phases, while provisioning, across a crashed runner or expired lease, and while a requested pause or abort winds down. It releases the slot as soon as it waits on the outside world: an open question, an acknowledged pause, a merge decision or merge gates, or other tickets (`ab wait-on`). When that wait ends (an answer, a resume, a moved target, a conflicted PR, an ended ticket wait) the build holds no slot until it is admitted again, ahead of normal ticket claims. Occupancy never exceeds `capacity`. Builds without a slot keep their workspaces, so retained workspaces can exceed `capacity`. An integration node holds a slot only while it verifies, not while collecting children. See [the integration tree](integration-overview.md). `ab builds`, `ab build status` and `ab repository status` report each build's slot state; see [Operator surfaces](operator-surfaces.md).

## Slot admission order

A free slot goes, in order, to:

1. `manual` start requests (`ab start`'s default);
2. urgent parked work: nodes and finished or waiting builds that must verify, reconcile, resume or propose;
3. urgent ticket claims: `ab start --priority urgent` requests, then urgent ready tickets;
4. normal parked work;
5. normal ticket claims: `ab start --priority normal` requests, then normal ready tickets.

Each tier keeps its usual order, start requests oldest first. A pending start request reserves its slot ahead of the tiers below it until it settles or is cancelled. An ordinary build takes its ticket's priority when it is claimed; a build started by an `urgent` request is urgent, and `manual` never becomes a build priority. An [optimization node's attempts](optimization-nodes.md#attempts) claim at the node's current priority instead: a later `ab priority` on the node affects attempts claimed afterwards, while an already claimed attempt keeps its build priority. `ab priority <slug> urgent|normal` (or the `builds.control` action `priority`) changes an active build's priority, for example to expedite a waiting reconcile that now blocks other work; it never changes the ticket. While urgent tickets are ready, normal parked work waits for a slot until the dispatcher has offered urgent tickets the free slots that tick. An urgent ticket blocked on a dependency reserves nothing. Priority orders free slots only: it never interrupts a running build. `ab repository status`, `ab builds` and both dashboards mark urgent waiters, pending start requests by tier and urgent ticket claims waiting ahead of normal parked work.


## The log is the source of truth

The BuildStore holds typed, append-only event logs and artifacts:

- **Per-build log.** Phase transitions, verdicts, escalations and answers.
- **Repository journal.** Dispatcher runs, harvest and operator settings.
- **Artifacts.** Specs, plans, reports and evidence.

State is reduced from those events; a snapshot is only a cache.

Agents report through the typed `ab` CLI (`ab done`, `ab verdict`), not their output; code validates the deposit, applies the gates and records the transition.


## Repository agent context

Every dispatcher, in checkout or origin mode, keeps a record of the repository's agent context in the store. It reads the committed tree at the base-branch head through the forge, never the working copy, so both modes record identical content for the same commit.

| Captured | Selection |
| --- | --- |
| Skills | Every directory under `.agents/skills/` or `.claude/skills/` holding a `SKILL.md`, with all its files: shipped, customized and repository-local skills alike. Symlinked or byte-identical copies appear once with every install path; dot-directories such as `.ab-pristine` are skipped. |
| Instructions | Every `AGENTS.md` and `CLAUDE.md`, root and nested. The two collapse into one entry per directory when identical. |
| Imports | Files the instructions import by `@path`, followed transitively, stored as separate entries. Paths outside the repository are listed as omitted. |

- **Revisions.** The record is a repository artifact, `agent-context`. A new revision is written only when the captured content changes, not on every base-branch commit. It is retention-managed like the dispatcher's run and config artifacts: the newest 200 revisions survive (`AB_ARTIFACT_RETENTION_MAX_REVISIONS` overrides the bound).
- **Pacing.** Each dispatcher process checks the base head on its first tick, then at most once a minute. An unchanged head reads no tree, blob, record or event. A capture cut short by an invocation deadline keeps the bytes it fetched and resumes on the next invocation.
- **Bounds.** A record over 2.25 MiB encoded (`oversize`) or 32 MiB uncompressed (`raw-oversize`) is not written. The last good revision stays, and the diagnostic names the largest contributors.
- **Scope.** The dispatcher captures only. Connected agents read the record through the [agent-context tools and prompts](operator-api.md#agent-context).

`ab dispatch` prints each diagnostic once:

| Diagnostic | Meaning | Next attempt |
| --- | --- | --- |
| `oversize`, `raw-oversize` | Bound exceeded; last good revision kept | When the base head moves |
| `tree-unlistable` | The forge cannot list a directory completely; last good revision kept | When the base head moves |
| `capture-failed` | Unexpected read or write failure | After five minutes, or when the base head moves |
| `unavailable` | The forge cannot read trees or blobs | None; dispatching continues |

A repository with no base branch yet has nothing to capture and reports nothing.


## Resume the work, not the chat

A restart loses nothing. The dispatcher continues each build from its recorded phase, completed boundaries, artifacts and feedback, even in a replacement sandbox. Authority boundaries hold:

- Unanswered phase and policy escalations stay parked until your operator agent answers. A janitor escalation keeps retrying and closes unanswered when an attempt succeeds.
- Pending operator commands and actionable work proceed.
- A restart never grants permission or resets an exhausted retry budget.


## The operator agent stays outside

Your operator agent is an external coding agent you direct, like Claude Code or Codex. It files and grooms tickets with you, operates the builds the repository's dispatcher dispatches, answers bounded escalations and manages merge consent, using the `ab` CLI locally or the same tools over MCP. You make the product calls. Autobuild never hosts or starts it, and its chat isn't part of the build's paper trail.

Next: [operator surfaces](operator-surfaces.md) for the controls, [one build end to end](builds.md) for the phases.

## Hosted dispatch and local viewing

A plain `ab dispatch` reads dispatch placement once before starting local execution.
For a hosted project it opens the viewer automatically, displaying
`viewer · dispatched by <host>` from the placement origin (including a nondefault
port). `--once`, `--plain`, and `--interval` retain their viewer meanings.
The viewer reads its dashboard from the Store; its one ticket-source read is
the header's triage count, through the source's optional `countStates`.
`--takeover` explicitly dispatches locally, with a warning that it can displace
the hosted dispatcher; it cannot be combined with `--viewer`. Startup intake
flags require `--takeover` when placement selects viewer.

An unreadable placement fails closed with a typed error naming the cause:
use `--viewer` to watch or `--takeover` to dispatch locally. Both explicit modes
skip placement discovery. Older services without the capability and projects
with unknown or nonhosted placement retain local dispatch behavior. Local stores
need no placement request. Failing to resolve the checkout's store selection
(for example, a malformed `autobuild.toml`) is not a placement failure: default
startup reports it as a repository resolution error naming its cause, and
neither explicit mode bypasses it. Origin mode (`--repository` or
`AB_REPOSITORY`) and hosted cron dispatch bypass this check. Placement is a startup snapshot, not a
liveness probe or a polling input.

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
stderr; a TTY dashboard keeps it on its top line. Both default to loopback. Serving beyond loopback has no access control;
see [operator surfaces](operator-surfaces.md) for binding and refresh details.
