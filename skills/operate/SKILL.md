---
name: operate
description: Orchestrate a repository's builds - file and groom tickets, watch builds, answer escalations, pause, resume, or abort builds, control merge consent, and drive work to merge. Use when asked to watch, shepherd, or orchestrate builds, whether from a coding-agent session at the repository root using the ab CLI or from an external connected agent using the operator tool registry.
---

# Operating the repository

The operator agent operates the builds the repository's dispatcher dispatches:
files and grooms tickets, watches builds, answers escalations and drives authorized
work to merge. Any external agent can take the role through the CLI or MCP.
Filing sessions check presence before taking the role; with a live operator,
they leave operating context in the ticket and stop. Explicit human instructions
always override that default. Presence is advisory, permits concurrent operators,
and grants no exclusive authority. MCP presence registration is deferred.

The operator agent is not a build phase: it never runs pipeline steps, never
edits the repository, and never touches a build's checkout. Its reach is the
operator surface — the `ab` CLI, or the operator tool registry exposed through MCP.

Find your setting and read that section: **Running locally with the `ab`
CLI** if you are a session with a shell, **Running as an external connected agent** if
your tools are the registry's `builds.*` / `tickets.*` family. The sections
after them apply to both.

## Running locally with the `ab` CLI

Each command acts with the human's authority, so say what you are doing
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
human instead of guessing.

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
unavailable binary, or failed local execution must be reported to the human;
never hide it with global fallback or install dependencies automatically.
Never use bare `bunx ab`, `npx ab`, `dlx`, or other registry-fetching
variants: the registry package named `ab` is not Autobuild. Offline cache
availability alone does not prove a local installation.

Only when no local declaration exists may you use global `ab`. In either
case run the resolved invocation with `--version` and report the invocation,
working directory, and actual version when you start orchestrating.

Every `ab …` example in this skill means this resolved invocation, run from
the same resolved working directory.

### Check presence before registering

Run `ab repository status --json` and inspect `operator.registrations`. If another
live operator is present, tell the human and do not become a second operator
unless directed. Otherwise arm a repository-wide `ab watch --operator --json`.
A flagged watch writes only mutable liveness, never events or a lease.

### Diagnose missing account credentials

Local startup refuses missing selected primary/alternate account sources before
taking the repository lease. Unused declared accounts do not block startup.
Read the aggregate error: supply the named environment slot, renew Claude with
`claude setup-token`, replace a Kimi membership key, or sign in ChatGPT with
`ab accounts login NAME --local`. A safely owned local refreshing login counts;
a failed, mismatched or unsafe record fails closed. Startup inspects live peer-owned
logins without claiming them, allowing the losing dispatcher to yield; execution
claims only after the repository lease is held.
Successor preflight refusal keeps the predecessor active and reports upgrade
attention; it never claims or rotates the predecessor's credentials.

Hosted absence appears as one durable repository condition per account, in
repository status, watch and dashboard warnings. Set `ab secrets set VARIABLE`,
or renew ChatGPT with `ab accounts login NAME --project`. The next tick resumes
automatically; do not retry builds or reset infrastructure attempts. Hosted
account slots never use service environment fallback. Config changes may also
hold account-dependent launches. Observation, controls and cleanup continue.
Presence is checked without inference; present rejected credentials retain their
account-specific rejection attention. See [accounts](../ab-guide/references/accounts.md#dispatcher-admission).
Credential/process changes remain subject to the Boundaries below.

### Watch for attention events

`ab watch --operator --json` is the standing monitor. Keep its default filter: every
record calls for action. It reports failed node verification, build escalations, persistent janitor failures and merge decisions,
harvest escalations/recovery exhaustion, automatic upgrade failures and runtime rollbacks, rejected configuration, reloads needing
restart, abnormal dispatcher stops/loss, ticket-source and forge degradation past reset (15 minutes
for ticket sources without reset), and five minutes of continuous tick failures. Advertised resets
wait for a post-reset tick to finish before requiring action; ordinary recovery
on that retry stays silent. Source grace and cooldown-driven failures do not
start the tick-failure clock. When failure writes are unavailable, dispatch watch
continues with local warnings and retries at least one second apart (or its
configured interval, if longer). Recovery records the bounded unreported window;
local warnings do not start durable attention retroactively. Explicit shutdown
still stops dispatch without waiting for reporting recovery. Routine outcomes and self-healing failures stay silent.

Every record carries a cursor; bounded watches end with a bare `{"cursor": …}`
line. Re-arm only with `ab watch --operator --json --since <watch-cursor>`,
using this standing watch's own cursor. Presence survives a re-arm gap of up to
five minutes after its last heartbeat on routine timeout/count completion.
Termination (SIGINT, SIGTERM, SIGHUP or stdout EPIPE) attempts withdrawal within
about two seconds; re-arming with the cursor re-registers the same ID/start.
Failed or unsupported withdrawal and SIGKILL fall back to TTL expiry.
`ab wait` neither heartbeats nor carries
registration identity. A separate unflagged diagnostic watch or wait must never
replace the standing monitor or supply its resume cursor.
Named diagnostic watches end when all named builds
are terminal; add `--repository` for repository attention. With no slugs all
active builds and repository attention are included. Reconcile status after
arming because historical build attention is silently baselined.

Add an extra monitor only for an identified need, such as a human asking
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
not establish idle intake; diagnose persistent trouble and report it to the human.

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
Any persisted stop suppresses loss, including an abnormal stop, which retains its
own default attention event. Correlation uses persisted per-run values without
full-log fallback. A validated successor takeover suppresses predecessor loss even while its sessions
drain. An unfinished handoff without takeover still reports loss on lease expiry;
successor loss and upgrade-failure/rollback attention remain independent.
It has no durable event envelope. Keep its cursor just as for event records;
resuming it suppresses repeated loss reports for that run. Inspect repository
status to diagnose the condition and report dispatcher trouble to the human.
Neither a loss observation nor a later retry authorizes dispatcher intervention.

### Keep going and adopt newly dispatched builds

Operate the builds the repository's dispatcher dispatches, including new builds
that appear after you arm. Finishing the initially queued set is no reason to stop.

1. Check presence as above, then arm `ab watch --operator --json` with no slugs.
   Retain its own cursor and re-arm with
   `ab watch --operator --json --since <watch-cursor>`.
2. Right after arming and after each timeout, run `ab builds --all --json`, adopt
   newly dispatched builds, inspect active builds with `ab build status <slug> --json`,
   and reconcile `ab repository status --json`. Historical attention is baselined
   by a fresh watch, so status reconciliation closes the attachment gap.
3. Handle each attention record using the shared rules. Repository records have
   no build slug: inspect repository status. Re-arm from the standing watch's
   latest cursor, including its trailing cursor after a timeout or count exit.
4. Report each merged, closed or aborted outcome and file or move tickets when
   warranted. A conflict or escalation requires action. Keep the standing watch
   alive and keep discovering work until the human ends or hands off the role.

Use `ab wait` and named unflagged watches only as separate diagnostics. They
cannot replace the registered monitor or its cursor. In MCP, use the existing
registry monitoring tools; operator presence is not exposed there.

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
  resolves with a revised spec; `--revise-spec-from-ticket` imports an amended ticket.
  Idle collecting or verification-failed nodes need no escalation and recollect
  for verification on the same head; children and contributions remain intact.
  Active work, pause, pending controls and merge intent refuse revision. Leaves
  require an escalation and restart from plan after any unfinished reconcile
  resumes under the revised spec and its publication is confirmed. Run `ab help answer` for the full menu.
- `ab pause <slug>` / `ab resume <slug>`; `ab pause --all` / `ab resume --all`
  hold and release the whole repository. Pause immediately interrupts live agent
  sessions and acknowledges after they stop. Resume continues the same native
  session where supported; remote or unsupported sessions rerun fresh, with a
  reason recorded in session.resume-fallback. Without a live agent (including
  check-only verify), pause still takes effect at the next boundary.
- `ab abort <slug>` — destructive: closes the PR, removes branches, and
  returns the ticket to triage.
- `ab hold <slug>` — persistently hold a merge and revoke earlier consent.
- `ab merge <slug>` — consent to a ready merge and clear its hold. Consent
  survives restacks and verification; use hold to withdraw it when work changes.
  Read the matched policy, readiness, acknowledged command and gate deferral in
  build status before acting. Work the consent queue by checking completeness
  and current verification, then issuing merge for the chosen merge. A merge
  acknowledgement accepts consent; it never promises that gates passed.
- Configure ordered `[[merge]]` rules for project policy through ab-guide.
  Repository auto-merge defaults and per-build auto-merge toggles are retired.

### Tickets

For feature sets you file yourself, consult the shared
[destination choice guidance](../ab-guide/references/integration-tree.md#choosing-a-destination):
explicitly choose root or a node, evaluate the repository's effective merge
policy, and explain the merge flow to the human. Ask when intent is unclear.

`ab ticket create|update|block|unblock|list|show|move|states` file, edit, and
move tickets; the `ab-tickets` skill covers the tracker's details. Moving a
ticket into the ready state sends it to dispatch — do that only when the
ticket genuinely conforms and the human's intent is clear.

### What the CLI does not offer

The registry has operator notes, harvest control, and `discard`, which have no
CLI equivalent, and no bulk control beyond `pause --all` / `resume --all`. Say
so rather than improvising; tell the human, or record it with `ab observe`
when you are inside a build. `ab mcp` mounts the same registry over MCP for
harnesses that support it — if you have those tools, the connected-agent section's tool
descriptions apply.

## Running as an external connected agent

This section applies when an external agent harness connects to the operator
registry through MCP. With a shell and the `ab` CLI, use the section above.
Follow each advertised tool schema, including its repository arguments; do not
assume repository identity is injected into calls.

### How you run

Your external harness owns the conversation, scheduling, output, checkpoints
and concurrency. The service does not load your prompt or operator notes, run
a durable agent loop, deliver wake messages, or resume you on a timer.
Read notes and current repository facts explicitly before acting. Tool writes
use the authenticated binding's operator identity: local MCP uses the local
operator identity; Operator API clients use their authenticated authority.
Do not assume session-owner delegation or a runner-provided repository scope.

### Human approvals

Respect a human denial as a firm no. Any approval or suspension flow in your
external harness belongs to that harness. Protocol session approval answers are durable records only. Do not repeat completed work when your harness resumes.

### The tool surface

Your tools are the operator registry. The read-only ones are always safe:

- `builds.list` — active, queued, or all builds, with effective status.
- `builds.get` — one build's detail.
- `builds.events` — one build's event log from a cursor (use a cursor; logs
  are long).
- `builds.artifact` — one artifact's bytes, base64-encoded.
- `repository.status` — the repository's derived status.
- `harvest.status` — the observation workflow's current state.

The mutating ones carry the human's authority — prefer the narrowest
that does the job, and say what you are doing before you do it:

- `builds.control` — pause, resume, abort, or discard a build. `abort` and
  `discard` are destructive to in-flight work.
- `builds.answer` — answer an open escalation: guidance text, a retry, a
  review-round ceiling, or a revise-spec resolution. Eligible idle collecting or
  verification-failed nodes accept body/ticket spec revision without an escalation;
  the caller supplies the amended body for ticket origin. The node recollects and
  verifies; leaves require an escalation and restart from plan after any unfinished reconcile
  resumes under the revised spec and its publication is confirmed.
- `tickets.list`, `tickets.get` — read the ticket queue and one ticket. A long
  queue pages with `limit`, `offset` and `order`; `total` counts every match.
- `tickets.create` — file a new ticket from a conversation.
- `tickets.update`, `tickets.block`, `tickets.unblock` — edit fields and
  blocker relations.
- `tickets.move` — move a ticket between workflow states. Moving a ticket
  into the ready state sends it to dispatch — do that only when the ticket
  genuinely conforms and the human's intent is clear.
- `notes.read`, `notes.write` — the operator-notes artifact: durable,
  human-readable notes about this repository's operation. Write what the
  next operator or human will need; explicitly read it before acting on
  anything you'd otherwise guess.
- `repository.settings` and `repository.bulk_control` — repository-wide
  switches; use sparingly and only on clear instruction.
- `harvest.control` — start or control an observation run.

Every tool returns the operator API's shapes: results, or a typed failure
(`kind`, `error`, `code`). A refusal is information, not an exception:
report it, adapt, and carry on.

### The attention set

Obtain current facts through supported status, event and monitoring reads.
Notifications may be stale; reconcile current state before acting on routine
outcomes or self-healing failures. The service does not automatically deliver
wake payloads to your external harness.

Treat every default-watch record as a call to act:

- `integration.verification-failed`: inspect the failed steps, verified head and parent, then recheck current status. If the node still needs that repair, file a repair child targeting it. Each current failed cycle reports once; recovery does not backfill superseded failures. The node may have advanced after notification.
- `escalation.raised`: inspect the question and evidence, then resolve it using
  the shared rules.
- `build.consent-ready`: inspect the one consent queue, then merge or hold the
  selected candidate under the human's policy. Unready or stale candidates
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
- Automatic runtime rollback: repository status names the failed and restored
  runtimes and effective hold. Three failed exits within ten minutes of takeover
  restore one previous cached runtime; preflight failures do not count. The failed
  target stays held despite store compatibility changes, resolution errors or
  upgrade opt-out. A different successfully resolved target or a fresh operator
  launch clears the effective hold. Existing phases keep their leases and continue
  on the restored runtime at their next boundary; unreadable decisive facts defer
  with attention. Report the evidence to the operator; agents never restart the
  dispatcher.
- Dispatcher loss, abnormal stop, restart-required reload, rejected config, or
  persistent tick failure: diagnose through repository status and report the
  condition to the human. Repository read failures fail the watch tick and
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

Make a best effort to resolve attention without human input. Inspect the
escalation, spec, code, build artifacts/events, and applicable operator notes.
Answer questions supported by that evidence, retry when the evidence warrants
it, and file or move tickets where that is clearly right, within the existing
ready-state authorization boundary. Investigate before asking; the exceptions
below govern when the evidence or available tools cannot resolve the issue,
or a human decision is required.

### When to escalate instead of act

Stop and ask the human — in plain streamed text — whenever:

- The action is destructive and not clearly instructed (`abort`, `discard`,
  a bulk control, a repository-wide setting).
- Two readings of the human's intent diverge in cost or risk.
- You would be guessing about product direction, priorities, or scope.
- A tool refusal repeats and you cannot resolve it with the tools you have.
- The attention event is one you cannot act on with the tools you have at all.

Filing a ticket is acting — do it when the request is concrete. Default to
resolving attention yourself within these boundaries; ask the human only
for the exceptions above.

### Boundaries

- Automatic generation handoff is product behavior, not agent process authority.
  Passing preflight permits draining when the selected store can be shared; unknown
  compatibility chooses cutover. Rejected protocol writes preserve the predecessor.
  Old local and remote executions retain leases while the successor owns repository work.
  At completed phase boundaries they durably request relaunch when the accepted
  target differs; the current owner resumes them on its immutable runtime without
  spending failure budgets or raising attention. Remote guests detach independently
  of local retirement, continue heartbeats, and refresh their archive on re-attach.
  Their captured authorization survives predecessor exit and late attachment.
  Cached registry runtimes resolve and cache their own version’s validated release
  asset on first guest use, so local launch requires no GitHub fetch.
  Source runtimes deliver exact packed code. Remaining local sessions suspend at the policy deadline and resume natively where
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
  process, and configuration management belong to the maintainer. Diagnose
  through repository status and report trouble to the human; reporting
  does not authorize process intervention, including on a later retry.

- You never claim to have done anything outside the tools you have. If you cannot
  observe it with a tool, say you cannot observe it.
- You never invent repository identity, ticket ids, or build slugs; every
  id you act on came from a tool result or the conversation.
- External harnesses own concurrency and incoming-message handling; the
  service provides no one-turn-at-a-time or queued-message execution guarantee.
- Where your harness provides shared operator notes, keep
  them current when you learn something durable.

## Drive the tree through one consent queue

The root is the configured base branch. A node is a named integration point;
its integration build collects child contributions on its recorded branch.
A target is the destination of a contribution. `ab ticket tree --json` (MCP
`tickets.tree`) shows exhaustive source metadata, including completed tickets
and empty nodes. A claimed build freezes its effective target; use build status
or queue entries for merge ancestry after a source ticket changes.

Start with `ab merges --json` (MCP `merges.list`). This is the one queue of
ready merges needing a decision: consent-policy candidates and held ready
candidates. Entries include the target, branch preview, candidate head/parent,
verification receipts and node children/completeness. Unknown completeness is
not zero children. A changed head or parent must regain current verification;
unfinished or automatically authorized candidates do not ask for attention.

Select a queue build in the terminal and use `l merge` or `o hold`, or run
`ab merge <slug>` / `ab hold <slug>`. MCP uses `builds.control` with action `merge`
or `hold`. Hold is available before readiness and suppresses automatic merge.
Merge rechecks readiness and live node completeness, so act on failures by
refreshing the facts. Open children keep a node collecting. When integration
verification fails, file a repair child targeting that node and let it merge
before retrying the node cycle.

Watch for decisions and conflicts with `ab watch --operator --json`; save its opaque cursor
and resume with `ab watch --operator --since <watch-cursor> --json`. Default attention includes
failed node verification (`integration.verification-failed`), node merges, node item conflicts, conflicted leaf replays and derived
`build.consent-ready` observations, including already-ready merges on first
repository-wide discovery. Readiness is identified by its durable
entry position: resuming suppresses the same episode, while a new candidate or
exit/re-entry can notify again. Explicit `--event` globs remain event-only.
Use `ab wait --for consent --for node-merged --for restack-conflicted --json`
for one wake; state waits return immediately when already satisfied. `--for
attention` also includes current failed node verification, consent readiness, janitor failure attention and merge/conflict attention.
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

A historical `publication.lost` does not prove that every copy of its candidate
is gone. Recovery checks the exact branch and private archive refs and retained
replay objects first. An available candidate continues guarded publication.
A genuinely missing reconcile or automatic restack candidate records
`publication.candidate-retired`, abandons its obsolete request, and replays the
producing operation with a fresh transaction identity. Its frozen target,
reconcile occurrence or automatic trigger, cycle, and message survive. The
retired candidate is excluded from archive requirements unless independently
required by proven history. This reconstruction consumes no infrastructure
attempt and no additional conflict occurrence; it needs no operator guidance.
A bare retry also clears an existing infrastructure-limit escalation through
ordinary retry semantics. Unavailable inspection defers rather than proving loss.

Leaf restack and reconcile publication retry classified transient forge or transport
failures six times after the initial attempt, waiting 30, 60, 120, 240, 300 and
300 seconds. `publication.retry-scheduled` records the operation, frozen rewrite
identity, episode anchor, failure ordinal, last error and absolute retry time;
restart resumes that schedule without rerunning a resolver whose candidate remains available. These retries do
not consume `maxPhaseAttempts`. A seventh transient failure records
`publication.retry-exhausted` and raises `publication-retry-limit`, naming the last
error and six retries. Answering that escalation opens a fresh publication episode
for the same retained intent without resetting agent phase failures. Pending
publication keeps its workspace through backoff and unresolved exhaustion.
Classified rate limits retain repository cooldown and consume no publication
retry allowance. Rejected pushes, lease conflicts, dirty trees and unclassified
errors retain their existing behavior.

Janitor failures are durable per-build episodes. Eligible failures retry after
30, 60, 120, 240 seconds, then at the configured cap (300 seconds by default).
Skipped polls preserve the episode across restart. After
`policy.janitorFailureAttentionSeconds` (600 by default), `build.janitor-failing`
notifies default watchers and appears on the build row. A successful attempt
clears it. `policy.janitorBackoffMaxSeconds` sets the positive integer cap.

A classified forge rate limit records repository degradation with `resetAt`.
Forge work waits during cooldown; passing the deadline permits a recovery
request; a successful probe records automatic recovery. An authorized operator
may explicitly override erroneous recorded state with
`ab repository forge-clear --forge <name> --reason <text>` or
`repository.forge_clear {repo, forge, reason}`. This appends a human-attributed
`dispatcher.forge-recovered` fact with the reason; it does not prove provider
success. A subsequent actual limit records a fresh cooldown. Hosted admission
requires a schema-valid finite ISO `resetAt` no later than server time plus
24 hours, inclusive; past deadlines remain valid. Rejection never clamps or
invents a provider reset, and historical events remain readable.
Native merge application failures keep candidate-specific retry eligibility,
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

GitHub shares in-flight and completed PR, branch/ref and comparison observations
across builds within one dispatcher tick. Opened nodes prime their tips and
commit distance with at most two reads: PR plus comparison, or parent branch
plus reversed comparison without a PR. Priming is best-effort: failures add a
diagnostic and ordinary parent/target observations continue, so a deleted parent
can still be replaced. Forge cooldowns and rate limits retain their gates.
Each admitted poll revalidates mutable resources
using exact-resource ETags; authenticated 304s spare the REST primary quota.
Adapter caches are bounded and restart/eviction falls back to fresh reads.
Writes, including Git publication and rewrites, invalidate observations before
attempting the mutation so acknowledgement reads remain fresh. Leaf PR polling
keeps its existing cadence. Readiness and merge inspections remain fresh.

For node cadence, durable wakes, restart behavior and CLI evidence, see
[node polling and status](../ab-guide/references/integration-tree.md#polling-and-status).

The total includes all attempted requests. Optional `restPrimary`,
`restNotModified` and `graphql` counts distinguish REST responses charged to the
primary quota, REST 304s and GraphQL calls. Transport failures and historical or
legacy observations can remain unclassified; absent fields never imply zero.
Shared requests are attributed to their first requester; cache hits count zero.

## Intentional node staleness

An open collecting node may intentionally trail its parent. Parent movement is
observed without starting replay. Use `ab restack <node>` (or `builds.restack`
with `{repo, slug}`) to request freshness; paused or blocked nodes retain the
request until their ordinary safety gates permit it. Completeness, merge,
queued dependency presence and accepted re-parenting supply automatic demand.
Nested nodes need independent demand. Inspect the shared parent commit distance
readout; unknown is unavailable evidence, not zero. Existing transactions finish
before fresh demand is evaluated. Leaves keep their usual restack points.
