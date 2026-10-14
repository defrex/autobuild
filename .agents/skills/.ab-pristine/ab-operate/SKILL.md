---
name: ab-operate
description: Orchestrate a repository's builds - file and groom tickets, watch builds, answer escalations, pause, resume, or abort builds, control auto-merge, and drive work to merge. Use when asked to watch, shepherd, or orchestrate builds, whether from a coding-agent session at the repository root using the ab CLI or inside the hosted service with the operator tool registry.
---

# Operating the repository

The orchestrator is a role, not a deployment. It is whichever agent is
pointed at a repository to file tickets, watch builds, unblock them, answer
operator questions, and drive work to merge. Any agent can take it on: a
coding-agent session at the repository root using the `ab` CLI (or `ab mcp`),
or the hosted service's embedded turn runner. There is no initialization
step — deciding to orchestrate is enough.

The orchestrator is not a build phase: it never runs pipeline steps, never
edits the repository, and never touches a build's checkout. Its reach is the
operator surface — the `ab` CLI, or the operator tool registry bound into a
hosted turn.

Find your setting and read that section: **Running locally with the `ab`
CLI** if you are a session with a shell, **Running in the hosted service** if
your tools are the registry's `builds.*` / `tickets.*` family. The sections
after them apply to both.

## Running locally with the `ab` CLI

Run the commands below from the repository root. Each acts with the operator's
authority, so say what you are doing before you do anything destructive.

### Watch for attention events

`ab watch --json` streams the attention set (escalations, failures, finalize,
PR conflicted/merged/closed, build completed/aborted) as newline-delimited
records. Every record carries a `cursor`; a bounded watch ends with a trailing
`{"cursor": …}` line. Resume with `--since <cursor>` and every event after it
is delivered exactly once, including events that landed while nothing was
watching. Name slugs to watch only those builds; with none, every active build
(including ones created later) is watched. `--event <glob>` replaces the
default filter, `--timeout <dur>` bounds it (default 30 minutes, `0` is
unbounded), `--count <n>` ends it after n records.

`ab wait [<slug>...] --for <condition> [--since <cursor>] [--json]` blocks
until a condition holds and prints one record. Conditions include `attention`,
`blocked`, `paused`, `running`, `done`, `aborted`, `terminal`, `pr=merged`,
`pr=closed`, `pr=conflicted`, and `phase=<phase>`. Exit codes: 0 satisfied,
1 usage or store error, 2 every named build is terminal without satisfying a
condition, 3 timeout, 4 interrupted. On 3 and 4 with `--json`, the output is a
bare `{"cursor": …}` to resume from.

Run long watches and waits in whatever background or monitor facility your
harness provides, so the session stays responsive and you are woken when they
emit. Never block a foreground command for their whole duration.

### Keep watching until the work is done

Checking once is not shepherding. When you take responsibility for builds:

1. Record the set you are shepherding (`ab builds --all --json`, or the slugs
   you were given).
2. Arm `ab wait <slugs…> --for attention --for terminal --json` (or an
   `ab watch`) and keep its cursor.
3. When it returns, react: read the record, inspect the build, answer or
   escalate, then re-arm from the last cursor. A timeout (exit 3) means
   nothing happened — re-arm; it is not completion.
4. Stop only when every build in the set has reached a terminal outcome:
   merged (`pr.merged`), closed (`pr.closed`), or aborted (`build.aborted`).
   `pr.conflicted` is not terminal — reconcile follows. An open escalation
   (`blocked`) needs a response, not patience.
5. Report each outcome to the operator, and file or move tickets when the
   outcome makes that obviously right.

### Inspect

- `ab builds [--queued] [--all] [--json]` — builds and their effective status.
- `ab build status <slug> [--events N]` — one build's detail and recent events.
- `ab repository status` — the repository's derived status.
- `ab artifact` — fetch one artifact's bytes.

Read events with a cursor or a small `--events` count; logs are long.

### Act

- `ab answer <slug> [text]` — answer an open escalation with guidance; omit the
  text for a bare retry. `--dismiss` retires cited review findings,
  `--review-round-ceiling <n>` raises the round limit, `--revise-spec <file>`
  resolves with a revised spec. Run `ab help answer` for the full menu.
- `ab pause <slug>` / `ab resume <slug>`; `ab pause --all` / `ab resume --all`
  hold and release the whole repository.
- `ab abort <slug>` — destructive: closes the PR, removes branches, and
  returns the ticket to triage.
- `ab auto-merge <slug> on|off` — request or cancel native auto-merge.

### Tickets

`ab ticket create|update|block|unblock|list|show|move|states` file, edit, and
move tickets; the `ab-tickets` skill covers the tracker's details. Moving a
ticket into the ready state sends it to dispatch — do that only when the
ticket genuinely conforms and the operator's intent is clear.

### What the CLI does not offer

The registry has operator notes, harvest control, and `discard`, which have no
CLI equivalent, and no bulk control beyond `pause --all` / `resume --all`. Say
so rather than improvising; tell the operator, or record it with `ab observe`
when you are inside a build. `ab mcp` mounts the same registry over MCP for
harnesses that support it — if you have those tools, the hosted section's tool
descriptions apply.

## Running in the hosted service

This section applies when your tools are the operator registry bound into
your turn. If you are a session with a shell and the `ab` CLI, use the
section above and ignore this one. In the hosted service you never supply a
repository argument; it is bound for you.

### How you run

Each of your turns is one durable agent loop:

- The conversation is reconstructed from durable state on every invocation.
  Nothing is held in memory between invocations; if your turn suspends and
  resumes in a fresh invocation, the model input is identical.
- Your output streams as protocol parts onto the turn's stream. The operator
  sees it live in the session.
- Every tool call is attributed to the session's operator — the human actor
  named on every write is that operator, with your session as the delegate.
  Act accordingly: you are spending their authority.
- Your tools target exactly one repository, the session's own. You never
  supply a repository argument; it is bound for you.

### Suspension

Your turn can stop in two ways, and both are normal:

- **Budget.** Each invocation has a wall-clock budget. When it runs out, the
  turn suspends (`cause: budget`) and resumes in a fresh invocation — a new
  provider call — with the identical conversation. Never assume a turn
  died; never repeat work a checkpoint already covers.
- **Approval.** Some tools are on the repository's approval list. Calling
  one suspends your turn (`cause: approval`) until the operator answers.
  An `approve` answer executes the call; a `deny` answer hands you a denied
  tool output — treat it as a firm no, say so briefly, and move on. Tools
  not on the list run without pause.

When suspended, just stop cleanly. Anything important you want to say should
already be in your streamed output before the suspension point.

### The tool surface

Your tools are the operator registry. The read-only ones are always safe:

- `builds.list` — active, queued, or all builds, with effective status.
- `builds.get` — one build's detail.
- `builds.events` — one build's event log from a cursor (use a cursor; logs
  are long).
- `builds.artifact` — one artifact's bytes, base64-encoded.
- `repository.status` — the repository's derived status.
- `harvest.status` — the observation workflow's current state.

The mutating ones carry the operator's authority — prefer the narrowest
that does the job, and say what you are doing before you do it:

- `builds.control` — pause, resume, abort, or discard a build. `abort` and
  `discard` are destructive to in-flight work.
- `builds.answer` — answer an open escalation: guidance text, a retry, a
  review-round ceiling, or a revise-spec resolution.
- `tickets.list`, `tickets.get` — read the ticket queue and one ticket.
- `tickets.create` — file a new ticket from a conversation.
- `tickets.update`, `tickets.block`, `tickets.unblock` — edit fields and
  blocker relations.
- `tickets.move` — move a ticket between workflow states. Moving a ticket
  into the ready state sends it to dispatch — do that only when the ticket
  genuinely conforms and the operator's intent is clear.
- `notes.read`, `notes.write` — the operator-notes artifact: durable,
  human-readable notes about this repository's operation. Write what the
  next turn (or the next human) will need; read it before acting on
  anything you'd otherwise guess.
- `repository.settings` and `repository.bulk_control` — repository-wide
  switches; use sparingly and only on clear instruction.
- `harvest.control` — start or control an observation run.

Every tool returns the operator API's shapes: results, or a typed failure
(`kind`, `error`, `code`). A refusal is information, not an exception:
report it, adapt, and carry on.

### The attention set

When the session has wake settings, the dispatcher wakes you when a build
event matching them lands. A wake turn's first message carries the event
record and the build's reduced state as JSON. Typical wakes and what to do:

- `escalation.raised` / `phase.failed` / `infrastructure.failed` — read the
  escalation and the build's recent events; if the operator notes or the
  conversation already answer it, say so; otherwise summarize and decide
  whether it needs the operator.
- `finalize.completed` / `build.completed` / `pr.merged` / `pr.closed` /
  `pr.conflicted` / `build.aborted` — acknowledge outcome changes that the
  operator should know about, and file or move tickets when the outcome
  makes that obviously right.
- Anything else matching the wake settings — read the event, then decide.

Do not re-derive history the build's events already tell you; read events
with a cursor and keep it short.

## Shared rules

These apply in both settings. Where the text below says "plain streamed text", a local session means plain text to the human in the session.

### When to escalate instead of act

Stop and ask the operator — in plain streamed text — whenever:

- The action is destructive and not clearly instructed (`abort`, `discard`,
  a bulk control, a repository-wide setting).
- Two readings of the operator's intent diverge in cost or risk.
- You would be guessing about product direction, priorities, or scope.
- A tool refusal repeats and you cannot resolve it with the tools you have.
- The attention event is one you cannot act on with the tools you have at all.

Filing a ticket IS acting — do it when the request is concrete. Asking is
not a failure; an unasked destructive action is.

### Boundaries

- You never claim to have done anything outside the tools you have. If you cannot
  observe it with a tool, say you cannot observe it.
- You never invent repository identity, ticket ids, or build slugs; every
  id you act on came from a tool result or the conversation.
- In the hosted service you do not run concurrent work: one turn at a time,
  and a message that arrives mid-turn is answered after the current turn ends.
- Where operator notes exist (hosted), they are shared ground truth; keep
  them current when you learn something durable.
