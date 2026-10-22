---
name: operate
description: Orchestrate a repository's builds - file and groom tickets, watch builds, answer escalations, pause, resume, or abort builds, control landing consent, and drive work to merge. Use when asked to watch, shepherd, or orchestrate builds, whether from a coding-agent session at the repository root using the ab CLI or inside the hosted service with the operator tool registry.
---

# Operating the repository

The orchestrator is a role, not a deployment. It is whichever agent is
pointed at a repository to file tickets, watch builds, unblock them, answer
operator questions, and drive work to merge. Any agent can take it on: a
coding-agent session at the repository root using the `ab` CLI (or `ab mcp`),
or the hosted service's embedded turn runner. There is no initialization
step — deciding to orchestrate is enough. By default, the agent that
specified and queued work (the `ab-spec` and `ab-tickets` skills) takes the
role for that work as soon as it is ready, unless the human opts out.

The orchestrator is not a build phase: it never runs pipeline steps, never
edits the repository, and never touches a build's checkout. Its reach is the
operator surface — the `ab` CLI, or the operator tool registry bound into a
hosted turn.

Find your setting and read that section: **Running locally with the `ab`
CLI** if you are a session with a shell, **Running in the hosted service** if
your tools are the registry's `builds.*` / `tickets.*` family. The sections
after them apply to both.

## Running locally with the `ab` CLI

Each command acts with the operator's authority, so say what you are doing
before you do anything destructive.

### Resolve the local invocation first

Before your first Autobuild command, read the repository's package manifests
and package-manager evidence. A direct `@defrex/autobuild` declaration in
`dependencies` or `devDependencies` requires the repository's installed
version. The manifest's own `name` and a transitive dependency are not declarations.

Determine the package manager from `packageManager` and the lockfile:
`bun.lock` / `bun.lockb`, `package-lock.json` / `npm-shrinkwrap.json`,
`pnpm-lock.yaml`, or `yarn.lock`. Resolve workspace context from the manifest
declaring the dependency and the repository's package-manager configuration.
If evidence conflicts or cannot establish the manager, diagnose and tell the
operator instead of guessing.

Verify that the dependency is already installed and that its installed package
exposes the `ab` binary you will execute. For node_modules installs, verify
that `./node_modules/.bin/ab` resolves to that installed
`@defrex/autobuild` package, not another package or a global binary. For Yarn
PnP, use Yarn's installed dependency and binary evidence to establish ownership.
Run from the resolved repository/workspace directory:

| Package manager | Local-only invocation |
| --- | --- |
| Bun | `bun run ./node_modules/.bin/ab …` |
| npm | `npm exec --offline --no --call './node_modules/.bin/ab …'` |
| pnpm | `pnpm exec ./node_modules/.bin/ab …` |
| Modern Yarn | `yarn run --binaries-only ab …` |
| Yarn Classic | `yarn run ab …` |

Replace the ellipsis with CLI arguments; for npm they go inside the quoted
call, with appropriate shell quoting. Do not add `--package` or an inferred
package name. The explicit path prevents global PATH fallback, and npm's
offline/no flags prevent registry installation. Modern Yarn's binary-only
selection supports installed PnP dependencies without assuming node_modules.
Before using Yarn Classic, verify its installed local binary and check that
`scripts.ab`, `scripts.preab`, and `scripts.postab` cannot intercept the
command. Report a script conflict instead of executing it.

These forms execute an already-installed dependency. A missing dependency,
unavailable binary, or failed local execution must be reported to the operator;
never hide it with global fallback or install dependencies automatically.
Never use bare `bunx ab`, `npx ab`, `dlx`, or other registry-fetching
variants: the registry package named `ab` is not Autobuild. Offline cache
availability alone does not prove a local installation.

Only when no local declaration exists may you use global `ab`. In either
case run the resolved invocation with `--version` and report the invocation,
working directory, and actual version when you start orchestrating.

Every `ab …` example in this skill means this resolved invocation, run from
the same resolved working directory.

### Watch for attention events

`ab watch --json` is the standing monitor. Keep its default filter: every
record calls for action. It reports build escalations, persistent janitor failures and merge decisions,
harvest escalations/recovery exhaustion, automatic upgrade failures, rejected configuration, reloads needing
restart, abnormal dispatcher stops/loss, ticket-source and forge degradation past reset (15 minutes
for ticket sources without reset), and five minutes of continuous tick failures. Advertised resets
wait for a post-reset tick to finish before requiring action; ordinary recovery
on that retry stays silent. Source grace and cooldown-driven failures do not
start the tick-failure clock. Routine outcomes and self-healing failures stay silent.

Every record carries a cursor; bounded watches end with a bare `{"cursor": …}`
line. Resume with `--since <cursor>`. Named watches end when all named builds
are terminal; add `--repository` for repository attention. With no slugs all
active builds and repository attention are included. Reconcile status after
arming because historical build attention is silently baselined.

Add an extra monitor only for an identified need, such as an operator asking
to hear when a particular build merges or an outcome triggering follow-up work.
Scope it to named slugs and explicit `--event` globs (for example,
`ab watch my-build --event pr.merged --json`), and retire it when that need ends.
An extra monitor supplements the default standing watch.

`ab wait [<slug>...] (--for <condition> | --event <glob>) [--since <cursor>] [--json]`
blocks until a condition holds and prints one record. `--for` state conditions
are also satisfied immediately by a build already in that state; `--event` is
satisfied only by new events. Conditions include `attention`,
`blocked`, `paused`, `running`, `done`, `aborted`, `terminal`, `pr=merged`,
`pr=closed`, `pr=conflicted`, and `phase=<phase>`. Exit codes: 0 satisfied,
1 usage or store error, 2 every named build is terminal without satisfying a
condition, 3 timeout, 4 interrupted. On 3 and 4 with `--json`, the output is a
bare `{"cursor": …}` to resume from.

Run long watches and waits in whatever background or monitor facility your
harness provides, so the session stays responsive and you are woken when they
emit. Use precisely the same resolved invocation and working directory as
foreground commands, including inside background shells and harness monitors.
Do not rely on a shell alias or function that those facilities may lose.
Never block a foreground command for their whole duration.

Ticket-source degradation records mean dispatch intake cannot evaluate the source;
existing builds may still advance. Inspect `ab repository status --json` for the
active cause, operation, message, and expected reset. Reset times are advisory;
recovery means reads actually succeeded. Allow the existing cooldown and retry
behavior, investigate persistent ready-scan failures or a condition still active
after its reset estimate, and keep watching through recovery. Empty builds do
not establish idle intake; diagnose persistent trouble and report it to the operator.

Repository records have null build and state. Handle them with repository
status rather than build commands, keep their cursor, and re-arm. A legacy
cursor without a repository position baselines that stream at attachment and
cannot recover its earlier interval: reconcile current repository status.
`ab wait --for attention` remains build-only and does not replace a repository
attention watch.


Runtime identity on `dispatcher.holder` describes the lease owner, independently
of the newest invocation; missing historical runtime is null.
Check dispatcher liveness with `ab repository status --json` after a watch
timeout or `dispatcher.lost` observation, or when dispatch appears unhealthy. Do not
use process lists to decide whether a dispatcher owns this repository. The
`dispatcher` projection distinguishes `held` (an unexpired lease), `lost`
(expired ownership without a recorded stop), `stopped`, and `absent`. Its holder
identity resolves a yield message to run, pid, host, start time, and heartbeat
age. Historical identity and a new holder's heartbeat may be unknown until its
first attributable renewal. Source degradation or an old tick alone does not
establish loss: a healthy lease can accompany a slow tick.

An unscoped watch, or a named watch with `--repository`, reports loss as a
read-only observation: `{repo, build:null, state:null, observation:{type:
"dispatcher.lost", run, observedAt, leaseExpiresAt, ...identity}, cursor}`.
It has no durable event envelope. Keep its cursor just as for event records;
resuming it suppresses repeated loss reports for that run. Inspect repository
status to diagnose the condition and report dispatcher trouble to the operator.
Neither a loss observation nor a later retry authorizes dispatcher intervention.

### Keep watching until the work is done

Checking once is not shepherding. When you take responsibility for builds:

1. Record the set you are shepherding (`ab builds --all --json`, or the slugs
   you were given).
2. Arm the default standing watch and keep its cursor:
   `ab watch --json --since <cursor>` (or named slugs with `--repository`) (omit `--since` the first
   time). Events are delivered exactly once, so a build that already finished
   is never replayed. Do not loop on `ab wait --for terminal|attention|…`:
   state conditions are satisfied at once by any build already in that state,
   even with `--since`, so a finished build would be returned again and the
   loop would spin on it. If you use `ab wait`, use only `--event <glob>`
   conditions (satisfied by new events only), never `--for`.
3. Reconcile current state right after the first watch is armed, and again
   whenever a watch ends without records: a watch baselines each build at its
   current position and does not emit what already happened, so a build that
   merged, or an escalation already open, before registration would otherwise
   never reach you. Run `ab build status <slug> --json` for every slug in the
   set, and `ab repository status --json` for source health, initially and after
   every timeout or legacy-cursor attachment. Reading status after arming leaves no gap — anything earlier shows in
   the status, anything later arrives as an event. Treat a terminal status
   (merged, closed, aborted) as that build's outcome, and an open escalation
   or merge decision as attention to handle now.
4. When a watch returns records, react: read the record, inspect the build,
   resolve attention using the shared rules; for a repository record inspect repository status and act
   on its condition without assuming a build slug. Then re-arm from the last cursor. Keep your own
   outcome table from status reconciliation after named-watch exit and bounded
   watch timeouts. Default watches do not emit routine merge/completion records. A timeout (exit 3, or a watch
   that ends with only a `{"cursor": …}` line) is not completion — reconcile
   as in step 3, then re-arm from that cursor.
5. Stop only when every build in the set has an outcome in your table.
   `pr.conflicted` is not terminal — reconcile follows. An open escalation
   (`blocked`) needs a response, not patience. A watch that exits because
   every named build is terminal still needs the step 3 status read to learn
   how each ended.
6. Report each outcome to the operator, and file or move tickets when the
   outcome makes that obviously right.

### Inspect

- `ab builds [--queued] [--all] [--json]` — builds and their effective status.
- `ab build status <slug> [--events N]` — one build's detail, chronological runner
  attaches with runtime identity, and recent events. Historical runtime is null
  in JSON and unrecorded in human output.
- `ab repository status` — the repository's derived status, including the lease
  holder’s recorded runtime version, commit, and source kind/location. Historical
  runtime is null in JSON and unrecorded in human output.
- `ab artifact` — fetch one artifact's bytes.

Read events with a cursor or a small `--events` count; logs are long.

### Act

- `ab answer <slug> [text]` — answer an open escalation with guidance; omit the
  text for a bare retry. `--dismiss` retires cited review findings,
  `--review-round-ceiling <n>` raises the round limit, `--revise-spec <file>`
  resolves with a revised spec. Run `ab help answer` for the full menu.
- `ab pause <slug>` / `ab resume <slug>`; `ab pause --all` / `ab resume --all`
  hold and release the whole repository. Pause immediately interrupts live agent
  sessions and acknowledges after they stop. Resume continues the same native
  session where supported; remote or unsupported sessions rerun fresh, with a
  reason recorded in session.resume-fallback. Without a live agent (including
  check-only verify), pause still takes effect at the next boundary.
- `ab abort <slug>` — destructive: closes the PR, removes branches, and
  returns the ticket to triage.
- `ab hold <slug>` — persistently hold a landing and revoke earlier consent.
- `ab land <slug>` — consent to a ready landing and clear its hold. Consent
  survives restacks and verification; use hold to withdraw it when work changes.
  Read the matched policy, readiness, acknowledged command and gate deferral in
  build status before acting. Work the consent queue by checking completeness
  and current verification, then issuing land for the chosen landing. A land
  acknowledgement accepts consent; it never promises that gates passed.
- Configure ordered `[[landing]]` rules for project policy through ab-guide.
  Repository auto-merge defaults and per-build auto-merge toggles are retired.

### Tickets

For feature sets you file yourself, consult the shared
[destination choice guidance](../ab-guide/references/integration-tree.md#choosing-a-destination):
explicitly choose root or a node, evaluate the repository's effective landing
policy, and explain the landing flow to the human. Ask when intent is unclear.

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

A wake turn's first message carries the configured event record and the
build's reduced state as JSON. Existing hosted wake settings are independent
of CLI watch defaults; reconcile current state before acting on their routine
outcomes or self-healing failures.

Treat every default-watch record as a call to act:

- `escalation.raised`: inspect the question and evidence, then resolve it using
  the shared rules.
- `build.consent-ready`: inspect the one consent queue, then land or hold the
  selected candidate under the operator's policy. Unready or stale candidates
  do not produce this observation.
- `build.merge-decision`: diagnose the current merge-gate deferral or unsafe
  forge outcome. Consent and hold decisions use only `build.consent-ready`.
- Harvest escalation or recovery exhaustion: inspect harvest status and resolve
  the reported blocker.
- Automatic upgrade failure: inspect repository status for the target, provenance
  and reason, including a rejected protocol-write preflight. The running generation stays active; the same failed input is
  suppressed until target or selected-store compatibility evidence changes or a fresh operator launch. Report
  launcher-contract changes or disabled automatic upgrades as manual restart
  needs. Agents still never manage the process.
- Dispatcher loss, abnormal stop, restart-required reload, rejected config, or
  persistent tick failure: diagnose through repository status and report the
  condition to the operator. Repository read failures fail the watch tick and
  retry on the next tick, using the existing five-minute persistent-failure
  attention. For validation failures, inspect the stored tick error for reducer,
  scope, cursor, field path, and running version/commit. Never start or run a dispatcher.
- Persistent source degradation: inspect the source cause and reset evidence,
  diagnose and report the continuing intake problem.

Do not re-derive history the build's events already tell you; read events
with a cursor and keep it short.

## Shared rules

These apply in both settings. Where the text below says "plain streamed text", a local session means plain text to the human in the session.

### Resolve attention by default

Make a best effort to resolve attention without operator input. Inspect the
escalation, spec, code, build artifacts/events, and applicable operator notes.
Answer questions supported by that evidence, retry when the evidence warrants
it, and file or move tickets where that is clearly right, within the existing
ready-state authorization boundary. Investigate before asking; the exceptions
below govern when the evidence or available tools cannot resolve the issue,
or a human decision is required.

### When to escalate instead of act

Stop and ask the operator — in plain streamed text — whenever:

- The action is destructive and not clearly instructed (`abort`, `discard`,
  a bulk control, a repository-wide setting).
- Two readings of the operator's intent diverge in cost or risk.
- You would be guessing about product direction, priorities, or scope.
- A tool refusal repeats and you cannot resolve it with the tools you have.
- The attention event is one you cannot act on with the tools you have at all.

Filing a ticket is acting — do it when the request is concrete. Default to
resolving attention yourself within these boundaries; ask the operator only
for the exceptions above.

### Boundaries

- Automatic generation handoff is product behavior, not agent process authority.
  Passing preflight permits draining when the selected store can be shared; unknown
  compatibility chooses cutover. Rejected protocol writes preserve the predecessor.
  Old local executions retain leases while the successor owns repository work;
  remaining sessions suspend at the policy deadline and resume natively where
  eligible, with reasoned fresh fallback otherwise. Harvest/provisioning work joins
  before repository authority transfers.

  Local harvest suspends durably before repository lease release on handoff or
  clean stop. The next generation resumes eligible native sessions with fresh
  logical credentials, or records a reasoned `harvest.session.resume-fallback`
  and starts fresh. Orderly suspension spends no recovery attempt; real
  crashes retain recovery accounting.
- Never start, restart, or stop a dispatcher: no `ab dispatch` in any mode,
  and no dispatcher process-management commands. This applies when the
  dispatcher is lost, stopped, absent, or failing repeatedly. Its lease,
  process, and configuration management belong to the operator. Diagnose
  through repository status and report trouble to the operator; reporting
  does not authorize process intervention, including on a later retry.

- You never claim to have done anything outside the tools you have. If you cannot
  observe it with a tool, say you cannot observe it.
- You never invent repository identity, ticket ids, or build slugs; every
  id you act on came from a tool result or the conversation.
- In the hosted service you do not run concurrent work: one turn at a time,
  and a message that arrives mid-turn is answered after the current turn ends.
- Where operator notes exist (hosted), they are shared ground truth; keep
  them current when you learn something durable.

## Drive the tree through one consent queue

The root is the configured base branch. A node is a named integration point;
its integration build collects child contributions on its recorded branch.
A target is the destination of a contribution. `ab ticket tree --json` (MCP
`tickets.tree`) shows exhaustive source metadata, including completed tickets
and empty nodes. A claimed build freezes its effective target; use build status
or queue entries for landing ancestry after a source ticket changes.

Start with `ab landings --json` (MCP `landings.list`). This is the one queue of
ready landings needing a decision: consent-policy candidates and held ready
candidates. Entries include the target, branch preview, candidate head/parent,
verification receipts and node children/completeness. Unknown completeness is
not zero children. A changed head or parent must regain current verification;
unfinished or automatically authorized candidates do not ask for attention.

Select a queue build in the terminal and use `l land` or `o hold`, or run
`ab land <slug>` / `ab hold <slug>`. MCP uses `builds.control` with action `land`
or `hold`. Hold is available before readiness and suppresses automatic landing.
Land rechecks readiness and live node completeness, so act on failures by
refreshing the facts. Open children keep a node collecting. When integration
verification fails, file a repair child targeting that node and let it land
before retrying the node cycle.

Watch for decisions and conflicts with `ab watch --json`; save its opaque cursor
and resume with `ab watch --since <cursor> --json`. Default attention includes
node landings, node item conflicts, conflicted leaf replays and derived
`build.consent-ready` observations, including already-ready landings on first
repository-wide discovery. Readiness is identified by its durable
entry position: resuming suppresses the same episode, while a new candidate or
exit/re-entry can notify again. Explicit `--event` globs remain event-only.
Use `ab wait --for consent --for node-landed --for restack-conflicted --json`
for one wake; state waits return immediately when already satisfied. `--for
attention` also includes consent readiness, janitor failure attention and landing/conflict attention.
Resume event backlogs with `--since <cursor>`; keep handling emitted records
before interpreting terminal completion.

### Own-build read deferral attention

`phase.deferral-escalated` is ordinary blocked attention: repair the scoped
CLI/store access described in its question before answering retry or guidance.
The answer authorizes a fresh session and clears no genuine phase failures.
Repeated classified read failures park immediately again; they do not consume
the phase failure allowance. Default watch and attention waits deliver the new
raise with its own event type.

## Forge failure recovery

Janitor failures are durable per-build episodes. Eligible failures retry after
30, 60, 120, 240 seconds, then at the configured cap (300 seconds by default).
Skipped polls preserve the episode across restart. After
`policy.janitorFailureAttentionSeconds` (600 by default), `build.janitor-failing`
notifies default watchers and appears on the build row. A successful attempt
clears it. `policy.janitorBackoffMaxSeconds` sets the positive integer cap.

A classified forge rate limit records repository degradation with `resetAt`.
Forge work waits during cooldown; passing the deadline permits a recovery
request, and only success clears degradation. A further limit extends cooldown.
Native landing application failures keep candidate-specific retry eligibility,
including automatic decisions without a human command. Retries recheck consent,
holds, verification and the exact candidate. Uncertain enables remain pending
until cancellation can be confirmed after cooldown. Publication retries reuse
cancellation receipts only when the forge confirms the same disabled state for
the same candidate and publication operation.

Tick telemetry counts provider wire requests, including failures. Counts are
unavailable for uninstrumented adapters. Attribution retains at most ten builds
ordered by descending count then build name; repository requests are unattributed.
Repository status names a hotspot only when one build makes at least two requests
and more than half of attributed requests. Telemetry never controls workflow.

## Intentional node staleness

An open collecting node may intentionally trail its parent. Parent movement is
observed without starting replay. Use `ab restack <node>` (or `builds.restack`
with `{repo, slug}`) to request freshness; paused or blocked nodes retain the
request until their ordinary safety gates permit it. Completeness, landing,
queued dependency presence and accepted re-parenting supply automatic demand.
Nested nodes need independent demand. Inspect the shared parent commit distance
readout; unknown is unavailable evidence, not zero. Existing transactions finish
before fresh demand is evaluated. Leaves keep their usual restack points.
