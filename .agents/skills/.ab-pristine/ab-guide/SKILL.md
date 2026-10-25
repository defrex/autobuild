---
name: ab-guide
description: Authoritative reference for the autobuild system as installed in this repository - the build lifecycle (grooming, dispatch, plan, plan-review, implement, code-review, verify, finalize, reconcile, merge), the complete autobuild.toml configuration surface, how `ab init` and `ab upgrade` treat config and vendored skills, and what each installed ab-* skill is for. Use when asked about how autobuild works or why a build did what it did; when editing autobuild.toml; when adding or changing a verify or finalize step; when configuring roles, runners, models, policy limits, dispatch, or ticket sources; when reading, editing, or upgrading the installed ab-* skills; when a question mentions autobuild, autobuild.toml, or the `ab` CLI; or when writing the product's own name in prose, documentation, or a UI string.
---

# Autobuild system guide

Install Autobuild in the target repository with `bun add -d --exact @defrex/autobuild`.
Here, `ab <command>` means the repository-installed CLI; run it as
`bun ab <command>`, for example `bun ab init`.

Reference material for an agent working on a repository that uses autobuild.
This skill describes the *system*. It drives no phase and changes no files.

## The integration tree

The configured `baseBranch` is the root. Work tickets are leaves; finite node
builds collect child contributions, verify their exact head and parent, and merge
under ordered policy. Targets freeze at claim; blockers are a separate graph.
Idle nodes consume no runner capacity and empty nodes have no PR.

- [Nodes, targets and the operating model](references/integration-tree.md)
- [Merge policy, examples and forge requirements](references/merge-policy.md)
- [Restacking, identity and recovery](references/restacking.md)
- [Migration from 0.x](references/migration-1.0.md)
- [Moving ticket sources](references/ticket-migration.md): recorded migrations preserve in-flight build continuity.

## How to use this skill

For first-time or existing-repository installation, including the local versus
Vercel decision and readiness check, follow the canonical
[repository setup procedure](references/setup.md).

Two rules come first, because they govern everything below.

**The repository decides its own configuration; this guide only describes the
system.** For anything repository-specific — what verify steps run here, which
runner a role uses, what `test` actually invokes — read the repo, not this
document:

- `autobuild.toml` at the repo root — the live configuration.
- `.agents/skills/ab-*/SKILL.md` — the installed skills *as this repo edited
  them*. They are editable by design, so the vendored copy may deliberately
  differ from the distribution's default described here.
- The project's own `CLAUDE.md`, `README.md`, and docs.

When this guide and the repository disagree about the repository, the
repository wins. Quote its files, not this one, when answering "what does this
repo do?"

**Supply context for what the user asked; never prescribe what they didn't.**
This skill is background knowledge for the request in the current session. It
is not a mandate to audit or improve anything. If you notice a config you find
suboptimal — a missing verify step, a policy limit you'd set differently — that
is not a finding to act on. Make the change the user asked for, and nothing
else. Mentioning an unrelated observation at most belongs in a closing
sentence, never in a diff.

## The product's name

Autobuild is one word. Write it `Autobuild` in prose and as a proper noun, and
`autobuild` in identifiers, commands, paths, config keys, and other technical
contexts. Never split or hyphenate it — not in UI strings, documentation,
comments, commit messages, or tests. The one exception is a verbatim quotation
of a name owned by an external system: that system's spelling is its own to
choose, not this project's to correct.

## The lifecycle

A groomed work ticket becomes a leaf build and walks a **fixed pipeline**:

```text
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize
      epilogue: (pr.conflicted → reconcile → verify:*)* → merged or closed
```

- **Grooming and dispatch.** Work enters at Triage. Ingesters *propose*
  tickets; a human grooms them to the complete
  [spec standard](references/spec-standard.md) — what and why but never how,
  verifiable acceptance criteria, explicit out-of-scope, and evidence — and
  dispatches. Generated work cannot leave Triage un-groomed. The dispatcher
  claims tickets that pass the `[tickets]` ready
  gate, chooses a short immutable slug from the final conforming spec, and
  starts builds up to the top-level `capacity` bound.
- **Ticket assets** — files or folders attached to a ticket (see
  [Ticket assets](#ticket-assets)) are frozen into the build at claim and
  appear under `$AB_CONTEXT_DIR/assets/` in every phase, as inputs alongside the spec.
  A `design` asset is part of the contract: `plan`, `plan-review`, `implement`,
  `code-review`, and agent verify steps judge against it, as a contract on
  observable visual and reference outcomes, not on implementation. Other kinds
  are reference material.
- **`spec`** — the ticket's spec becomes the build's contract. The `ab-spec`
  skill is the human-interactive surface for producing it, and it runs *before*
  a build exists.
- **`plan ⇄ plan-review`** — the planner turns the spec into a plan and may
  select configured optional verify steps in its opening front matter; a fresh
  reviewer (no memory of prior rounds, by design) reviews both together and
  approves, asks for a revision, or escalates. The loop repeats until approval
  or a policy limit.
- **`implement ⇄ code-review`** — the implementer executes the approved plan,
  committing locally; a fresh reviewer reads the diff against spec and plan.
  Same loop shape.
- **`verify:*`** — ordered stages, each containing one or more step phases.
  Members run concurrently and the next stage waits for every pass or skip.
  A failed stage sends every failed report to `implement` after its siblings
  settle; an optional `failFast` failure cancels unfinished siblings.
- **`finalize`** — the agent writes the PR description; the kernel opens the
  PR. `[finalize].steps` run afterward and are failure-tolerant. A
  content-producing step commits selected files locally and finishes clean;
  the runner pushes the exact descendant SHA and confirms forge readback before recording success.
- **Restacking and epilogue.** The kernel replays one net leaf change at verify
  entry and when its destination moves while awaiting merge. Clean replay
  starts no agent; conflicts enter `reconcile`, then verification. The leaf
  terminates **merged** or **closed**. See the [replay reference](references/restacking.md).

Integration builds use collect → verify → merge → close, with demand-driven node restacking,
repair children and source-aware reconcile as needed. Their exact-head/parent
verification differs from clean waiting leaf rewrites. See the
[node lifecycle](references/integration-tree.md#collect-verify-and-merge).

**Review severity is proportion to the spec.** Both review loops rate a
finding by what the defect costs against the spec's acceptance criteria and
the realistic operating conditions of the work under review, not by how
certainly it is a defect: `blocking` names an acceptance criterion the defect
defeats, `important` names a criterion or stated invariant it puts at material
risk. A true defect that puts no acceptance criterion at risk, breaks no
stated invariant, and is unreachable under realistic input is `ab observe`,
not a finding, and work carrying such observations is approvable. A reviewer
does not raise a bar the spec set: where the spec bounds a failure model or an
operating condition, a stricter model is not a defect, and hostile or
pathological input that the surface's contract does not promise to handle is
`minor` or an observation, unless a security boundary, an acceptance
criterion, or a stated invariant makes it material.

**The grammar is fixed.** `verify:*` and `finalize:*` are the *only* extension
points. There are no custom phases, no DAGs, no reordering — a repo extends
Autobuild by configuring verify stages and serial finalize steps. Ordered verify
groups do not add workflow phases or arbitrary dependency graphs.
If a request seems to need a new phase, say so rather than improvising one.

**Observation harvest is not a build phase.** On each dispatch tick, dispatch
measures both unclaimed observation count and drift: distinct other builds
merged after the oldest unclaimed observation. It starts when count reaches
`[policy].harvestThreshold` **or** drift reaches
`[policy].harvestMaxDrift`; zero disables drift. The originating build is
excluded even if it later merges, and only durable same-repository `pr.merged`
facts count. Either trigger claims the whole current accumulation and records
`count`, `drift`, or `both` on `harvest.started`, then dispatch runs one
repository-scoped workflow: deterministic `scan`, agent `synthesize`
⇄ fresh adversarial `review`, then deterministic `file`. Only approved
spec-standard proposals are created, in `[tickets].proposalState` — the triage
state unless this repository has named another one. The scan context exposes
existence and resolution for each distinct observation-origin ticket. At filing,
matching-source origins are refreshed and every still-existing unresolved one
is unioned with the agent-declared `blockedBy` ids; missing, resolved, foreign,
and absent origins are dropped. Filing records declared and origin-derived
blockers separately, while duplicate ids appear only once on the created ticket.
If the ticket is already visible as ready while that create is still unfinished,
dispatch correlates its source creation key with the durable reservation and
withholds it without consuming capacity; it remains in queue depth with a
distinct durable diagnostic, then proceeds normally after filing settles or the
owning workflow stops. A repository journal, artifact stream, dedup ledger, and lease make every step
queryable and crash-safe without polluting `ab builds` or the fixed phase grammar. Claims
exclude observations until they are dispositioned or selectively released;
idle ticks launch no harvest agent. A non-retrying infrastructure failure parks
its run at the durable boundary. Before any new scan, dispatch recovers every
ordinary parked run in start order, even when later runs shadow it, with a
fixed two-attempt budget applied independently per run. Automatic and human
reopening share `harvest.resumed`; one human acknowledgement reopens every
ordinary parked run and acknowledges every exhaustion barrier. Claims,
artifacts, attempts, reservations, and filing facts stay intact, so completed
work is not repeated. After a run's bound, one atomic fact commits only
classifiable filed creates, still-valid frozen joins, and suppressions; missing
creates, tombstone/unknown joins, and otherwise unclassifiable members are
released as pending. A rejected store read remains retryable infrastructure,
while successfully read malformed content fails safe toward release. The same
fact raises a human-attention barrier. Acknowledging it permits a future scan
but never resurrects an exhausted run. Existing journals gain these semantics
on replay without migration; completed and deliberate escalated runs remain
terminal.

**Slug naming is not a phase.** For each new build, a tool-free one-shot call
proposes a lowercase kebab base of at most three meaningful spec-derived words.
The dispatcher owns a hard deadline, strict validation, and store-wide `-2`,
`-3`, … collision suffixes. Absence or any failure falls back to the first
three words of the kebab-cased title, so naming never blocks dispatch. The slug
and `ab/<slug>` branch are chosen once; existing builds are never renamed.
Naming inherits `[roles.default]` and can be overridden by `[roles.slug]`.

## Who does what

The **operator** is the role driving Autobuild through `ab` or MCP, normally
an agent. The **operator agent** operates the builds the repository's dispatcher dispatches, adopting new builds as they appear; a human may drive the same
interface directly. The human is **you**, or the **maintainer**. Human actor
identities and session ownership attribute authority to the authorizing account,
not to the agent driving the tools.

The distinctions that change an administrator's answer:

- **Agents supply judgment** — planning, reviewing, implementing, verifying,
  and narrow non-phase proposals such as slug naming or skill-conflict text. An
  agent never decides a transition or whether any proposal is valid enough to
  apply.
- **The kernel owns determinism** — phase transitions, gating, deduplication,
  convergence and stall detection. Outcomes come from the typed `ab` CLI, never
  from parsing an agent's stdout.
- **The BuildStore is append-only event logs.** The kernel reduces build status
  from each build stream; dispatcher settings and harvest state are reduced
  independently from the repository journal. Snapshots are never authoritative.
  Events record facts, never derived state.
- **The interactive dashboard is a Store-only frontend.** It owns the terminal
  and supervises a private child that owns dispatcher ticks, build runners,
  Harvest, config/plugins, and ticket/forge/workspace/runtime adapters. Effective
  config, standing queue depth, diagnostics, reload outcomes, runner outcomes,
  and child health are run-correlated repository facts. Controls append directly
  to the Store, so a slow claim or agent turn cannot delay a keypress. Repository
  reads advance incrementally. SIGINT, SIGHUP, SIGQUIT, and SIGTERM restore the
  terminal immediately, drain and reap the child, and keep repeated signals
  graceful until an open claim tick reaches a recoverable boundary; non-SIGINT
  termination is replayed only after that drain. Durable normal/forced/abnormal
  evidence retains available process detail, and parent-death detection prevents
  a detached kernel. Resident checkout dispatch first runs a filesystem-only
  launcher that snapshots the invoking installation and its installed production
  dependencies offline into `.autobuild/runtime/`. The generation's frontend,
  kernel, later local runners and agent PATH CLI execute from that immutable
  root. The launcher owns no Store/lease and uses only the versioned v1 process
  contract. Automatic upgrades default on: the kernel checks immediately and every
  60 seconds, resolving a declared Autobuild dependency and Bun lock from the same
  authoritative base-branch commit. Unpinned repositories reread the original
  installation pathname, retained across handoffs. Launching from a source root
  sharing the dispatched repository's Git common directory selects source mode
  first; that eligibility and the initial packaged baseline stay frozen across
  successors. Source mode follows the forge-authoritative base commit, exported
  into private cache staging with a frozen-lockfile, script-free dependency
  install. The immutable runtime records the exact commit. Adoption compares
  actual packaged contents and production-reachable lock records, so same-version
  changes adopt while excluded-file and unrelated workspace-lock advances do not.
  Shipped documentation counts as packaged content. The advisory successful
  target-resolution fact exposes mode/base/SHA independently of the running
  commit and earlier failures or handoffs; identical polls append nothing.
  Feature branches and checkout pins never choose the target. Preparation validates an exact runtime in isolation;
  failures retain the current generation and raise repository attention, suppressed
  for the same input until target or selected-store compatibility evidence changes or a fresh operator launch. The successor
  preflights config, selected-store compatibility and durable protocol writes before
  requesting yield. SQLite compares semantic schema requirements, accepting equivalent
  migrated catalogs without initializing the live store. A failed request cannot be
  accepted or revived by detection; a newly prepared attempt must pass preflight.
  Compatible generations drain: the predecessor releases terminal
  input/rendering and repository authority, then supervises only captured local
  executions while the successor owns ticks and launches. The presenting input
  subscription reasserts raw termios on activation and every 100 ms, repairing
  retired processes' exit-time restores on the next maintenance turn (subject
  to event-loop delays). It cancels maintenance before release, suspension or
  shutdown and restores prior raw/flow state, leaving the shell cooked. Local and remote runners finish
  their current phase, compare their immutable attach runtime with the accepted
  target using existing boundary facts, and durably request relaunch on mismatch.
  Remote recovery confirms whole-sandbox stop before recording an execution end
  or releasing its lease; command exit alone is insufficient. Stop failure defers
  publication and replacement until teardown succeeds.
  Confirmed teardown has the neutral `relaunch` outcome; the current repository
  owner resumes from durable state on its runtime, even after an ownership gap.
  Equal or absent targets preserve normal execution. Unknown/incompatible
  provider evidence selects immediate-suspension cutover. Rejected protocol writes
  fail preflight and preserve the predecessor. The hot `policy.upgradeDrainSeconds`
  defaults to 900; remaining local sessions suspend at that deadline and resume
  natively where eligible, with reasoned fresh fallback otherwise. Remote runners
  detach with leases and heartbeats intact. Their exact instances and guest runtimes
  are captured separately, authorize boundary relaunch even after local retirement,
  and never delay predecessor exit. Recovery reads only open-execution builds,
  once per build per tick, so ended historical captures add no build reads.
  Re-attachment reinstalls the target archive.
  Cached registry generations resolve and cache their version’s validated GitHub
  release asset on first guest use; local launch requires no GitHub fetch.
  Source generations deliver their exact packed code. Repository-owned harvest/provisioning work joins before lease release.
  Durable takeover and retirement completion are separate; status exposes both
  runtimes, outstanding draining executions and deadline. The launcher keeps live
  runtimes reserved and joins all children on operator stop.

  With rollback-capable launcher and generation peers, three failed successor exits
  within ten minutes of the original durable takeover restore the immediately previous
  cached runtime. The first two failures restart the same runtime without repeating
  preflight. Preflight failures never count; outside that window ordinary failure
  exit behavior applies. Rollback goes back one runtime only. The launcher opens no
  store: it passes a validated, versioned recovery context to the restored generation,
  which records `dispatcher.runtime-rolled-back` under repository authority and holds
  the failed target for that launcher lineage. Store compatibility changes, resolution
  errors and disabling/re-enabling upgrades do not clear this hold. A successfully
  resolved different target records `dispatcher.rollback-hold-cleared`; a fresh operator
  launch starts a new lineage. Both previous and held runtimes remain protected from
  cache pruning. Existing phase executions keep their leases and continue on the
  restored runtime at the next boundary; unreadable decisive facts defer a build with
  attention before any action. Peers without negotiated rollback capability retain
  existing failure behavior and report that capable runtimes are required.
  `[upgrade] automatic = false` disables preparation. A target or launcher without negotiated preflight/overlap capability, or a changed
  launcher contract, requires manual restart.

  Local harvest suspends durably before repository lease release on handoff or
  clean stop. The next generation resumes eligible native sessions with fresh
  logical credentials, or records a reasoned `harvest.session.resume-fallback`
  and starts fresh. Orderly suspension spends no recovery attempt; real
  crashes retain recovery accounting.
  Current, distinct previous, held and live-process runtimes survive pruning.
  Cached Bun entries disable auto-install and explicitly pin a neutral compiler
  config. Third-party files remain as installed. `--plain`/non-TTY run directly
  within the generation; `--once`, origin/hosted and hot development paths bypass
  the launcher. `--once` remains one tick plus drain.
- **Live configuration** has two explicit contexts. A running dispatcher owns
  the last valid snapshot from the **main checkout**; dispatch, setup, and each
  pipeline step capture it at their action boundary, without interrupting an
  agent turn or command already running. Missing, unreadable, malformed, and
  routing-invalid candidates retain that snapshot with deduplicated operator
  notice, and restoring a valid file resumes reload. Scoped phase CLI processes
  still read the build worktree's branch-owned file. Dispatcher merge readiness,
  resume, and execution recovery use the runner's pinned commands, verify, and
  finalize configuration through the cycle capture's exact artifact revision.
  At every verify-cycle entry, after restack or reconcile settles, the runner
  reads `autobuild.toml` from the execution checkout at resolved `HEAD` (including
  detached integration heads). `verify.config-captured` cites an immutable
  `verify-cycle-config` artifact revision, checkout head, build-owned content
  identity and truthful source metadata. Dirty worktree bytes carry
  `worktree-dirty` without a commit. A settled stage boundary rechecks the
  build-owned sections and the known source commit's ancestry. A change or
  non-ancestor source records `verify.config-superseded` and starts a fresh cycle
  before constructing any further member. Already launched siblings settle first.
  A waiting leaf with completed verification retains its receipts after a clean
  rewrite when build-owned config is unchanged, even when the rewrite replaces
  the pin commit's ancestry. Changed config still supersedes while waiting; a
  future verification cycle always captures fresh config before running steps.
  Old pass/skip receipts cannot satisfy that cycle, and supersession creates no
  failure or failure-budget charge. Unchanged config on a descendant head retains
  its pin; every new cycle still rereads the checkout. Read, parse and Git evidence
  failures block verification as infrastructure failures. Recovery and readiness
  read the capture's exact revision, so a concurrent deployment reload cannot
  replace its build-owned sections. Historical streams capture before further
  verification. Deployment-owned reloads remain live; environments are not
  re-provisioned.
- **Workspaces** are provisioned per build and remain the locally reachable
  execution context for that build.
- **Ticket providers** (`linear`, `file`) sit behind one port; the dispatcher
  does not know which is configured.
- **Forge operations and pushes are kernel-side plumbing.** Agents commit
  locally and never push, never touch a remote, never open the PR. The forge
  acknowledges the exact intended SHA; local refs are caches refreshed after
  confirmation. Local implementation publication failures write no completion or
  pending request and leave the same session retryable. A push
  happens at the implement terminal boundary or after the runner validates a
  successful content-producing finalize post-step. Reconcile alone uses an exact expected-head guarded rewrite after archiving every recorded Git tip under `refs/autobuild/archive/<slug>/<sha>`.
  `github` publishes through GitHub. `local-git` performs no remote/network/`gh`
  operation: durable PR records live under private Git refs, the review locator
  is `refs/heads/ab/<slug>`, and consent merges a local guarded, unsigned squash
  whose message is the deposited PR description and whose author and committer
  come from the repository's ordinary Git identity. If Git cannot resolve that
  identity, the PR remains open with actionable `user.name` / `user.email`
  guidance and later dispatcher ticks retry. Without consent it remains open for
  ordinary `git diff` inspection; it has no review UI or image host.

For moving a project between sources, follow the [ticket migration procedure](references/ticket-migration.md).

## Independent hosted tickets

Hosted tickets support local builds. Configure `[tickets] source = "hosted"`,
`teamKey`, and `url`, or run `ab connect --tickets URL` to register the project,
save its credential and publish ticket policy without changing the build store.
Without `tickets.url`, tickets use the selected remote build service; local builds
require an explicit ticket URL. No dispatcher is needed for ticket commands.
Hosted defaults are `triage`, `ready`, `doing`, `done`; create/proposal use triage.
Other sources still require readyState. Explicit state names retain their spelling.
Legacy clients without independent policy retain uploaded configuration defaults.
Harvest ticket grants are service-bound read/create authority; child phases are
read-only and cannot publish policy. See [setup](references/setup.md) and the
[ticket protocol](references/remote-ticket-protocol.md).

## `autobuild.toml` reference

One declarative file at the repo root. **Declarative, not executable** —
commands are plain shell strings that the kernel runs; nothing in this file is
evaluated as config logic.

**Strictness:** unknown top-level keys/tables and unknown keys inside known
tables are **errors**, not warnings — a typo must not silently disable a
verifier. The open maps are `[commands]`, `[roles]`, `[workspace.config]`,
`[workspace.config.runtimeProvisioning]`, `[verify.<step>]`, and
`[finalize.<step>]`. Autobuild strictly validates the
repository-defined command, role, and step entries. `[workspace.config]` is
plugin-owned and passed through unchanged for plugins; the builtin `git-worktree` provider requires it to be
empty, while `vercel-sandbox`
interprets it as a closed typed table.
Every other known table is closed to unknown keys. The removed `[dashboardFrames]`, `[project]`,
`[dispatcher]`, `[harvest]`, and `[outer]` tables have no aliases or migration
shims; they fail as ordinary unknown top-level keys.

Ticket-source ready scans run immediately when no completed measurement exists,
then every
`ticketScanIntervalSeconds` (default 60 seconds, a positive integer). Actual
tick spacing is the floor when the configured interval is shorter. A
same-repository `pr.merged`, `build.completed`, or `build.aborted` fact forces
another scan on the next tick; changed ready criteria also force a scan.
Housekeeping keeps its ordinary tick cadence. Between scans, queue depth and
standing diagnostics repeat the last completed measurement, including across
process restarts. Tickets groomed directly in the tracker are picked up within
one scan interval plus one tick when capacity permits. Observation while intake
is off shares the cadence; an observation measurement cannot suppress a fresh
admission scan when intake is enabled.

### Root scalars

Root scalars must appear before the first TOML table; TOML otherwise nests them
under the preceding table.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `baseBranch` | `"main"` | nonempty string | The branch builds branch from and target with their PR; what `reconcile` replays the build change onto. |
| `ticketScanIntervalSeconds` | `60` | positive integer seconds | Hot-reloaded ready scan cadence; tick spacing is the floor, and same-repository merge/completion/abort forces an early scan. |
| `capacity` | `1` | positive integer | Maximum concurrent builds for this repository. |
| `forge` | `"github"` | nonblank string | Selects shipped `github` or `local-git`, or a plugin-registered Forge adapter. `github` authenticates with `GITHUB_TOKEN`, then `GH_TOKEN`, then the gh CLI's stored login. |
| `plugins` | `[]` | array of unique nonblank module specifiers | Trusted Bun plugin modules loaded before dispatch, `ab ticket`, and scoped phase wiring. |

Repository-path specifiers resolve from the config-bearing root, which is the
immutable build worktree in scoped phases. npm package specifiers resolve from
the consuming main checkout's installed dependencies first, then from the
Autobuild installation the CLI runs from as a fallback. Install extensions in
the consuming repository with `bun add -d --exact @defrex/autobuild-<extension>`;
a repository copy wins over an installed one, and missing
packages fail and are never installed automatically. Specifier strings must be
unique: an exact repeat fails config
validation before resolution or evaluation, identifies the repeated value and
both positions, and tells the operator to remove or deduplicate it. Distinct
specifiers remain separate declarations; if they register the same adapter
name, the collision error still identifies that adapter and both plugin owners.
Modules are trusted, in-process Bun code and cannot shadow builtin or previously
registered names. All four registration maps have production selectors:
`[tickets].source`, the root `forge` scalar, `[workspace].provider`,
and `[roles.*].runtime`. BuildStore uses the remote HTTP protocol, not this
manifest, and TelemetrySource has no registration map.

For the complete author workflow—from choosing one of the four open ports,
through the strict versioned manifest and environment-only secrets, to the
unchanged shared contract suite and optional npm publication—read
[`references/plugin-authoring.md`](references/plugin-authoring.md).

### `[store]`

| Key | Required | Values / purpose |
|---|---|---|
| `url` | When `[store]` exists | Absolute HTTPS service base URL; loopback HTTP is allowed for development. No credentials, query or fragment. Trailing slashes are normalized. |

Selection is explicit `--store` > nonblank `AB_STORE` > `[store] url` > the main
checkout's `.autobuild/`. A configured service without a user credential fails
with `ab connect` guidance. `AB_TOKEN` overrides the saved service/project
credential. See [repository setup](references/setup.md#connect-a-project).
Changing the store requires restarting dispatch.


### `[merge]`

Declare an ordered array of rules with `[[merge]]` headers. Each rule ANDs
its predicates; the first match wins. Omitted predicates are wildcards.
An unmatched leaf defaults to `auto`; an unmatched node defaults to `consent`.
Rules are strict and blank predicates are rejected with their array index.

| Field | Required | Values / purpose |
|---|---|---|
| `into` | No | `root`, any `node`, or an exact frozen destination node ticket id. |
| `from` | No | `leaf` or `node`. |
| `label` | No | Exact, case-sensitive source ticket label sampled at readiness. |
| `mode` | Yes | `auto` or `consent`. |

Help the human choose policy around their release process. A solo team can
use one catch-all `mode = "auto"` rule. A team requiring a human's review
for every merge can use one catch-all `mode = "consent"` rule. For release
nodes that collect work automatically but require a final click, put an
`into = "root"`, `mode = "consent"` rule first, followed by a catch-all
`mode = "auto"` rule. A broad rule placed first shadows narrower rules below
it. Use `from = "node"` or a release label to narrow that root decision when
ordinary leaves should follow a different release process.

Specific-node matching uses the claimed build's immutable destination, never
the source ticket's current parent. Decisions retain the sampled labels,
matched rule index and snapshot (or explicit default). Policy is live
dispatcher configuration, excluded from pinned pipeline settings and
integration verification inputs; later config edits do not rewrite an earlier
decision's provenance.

### `[pr]`

Optional PR-projection settings. Omission leaves artifact attachments text-only.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `imageHost` | — | optional `[pr.imageHost]` table | Opts attached images into temporary public hosting and inline PR rendering. |

### `[pr.imageHost]`

Optional and **off by default**. Any agent session may explicitly designate an
exact deposited artifact with `ab artifact put <kind> <file> --attach`. Every
attachment receives a pinned BuildStore download command in the PR summary.
When this table is configured, only attachments whose normalized media type is
`image/*` are copied to an existing public GitHub release and rendered inline;
non-images remain text-download-only. The release must already be published and
mutable; Autobuild creates no release or tag. A private source repository must
name a separate public asset repository because GitHub's image proxy cannot
fetch authenticated assets. This is an explicit temporary-public-disclosure
opt-in.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `provider` | — | required literal `"github-release"` | Selects the only image host implemented in this release. |
| `repository` | — | required nonblank `"owner/repo"` pair | Public repository that owns the pre-existing release. |
| `releaseId` | — | required positive integer | Numeric GitHub release id used for upload and deletion. |

The `gh` identity running Autobuild needs Contents write permission on the host
repository. Obtain an existing release's numeric id with, for example,
`gh api repos/owner/repo/releases/tags/<tag> --jq .id`. Upload, validation, or
timeout failure records a follow-up observation and preserves every exact text
retrieval command; it never changes verification or blocks finalize. Hosted
copies are deleted after `build.completed` (404 is already clean), and failed
deletions remain durable and retry on later dispatcher ticks. Their inline URLs
therefore intentionally stop working after the review window. The authoritative
BuildStore artifacts remain queryable under the store's separate retention
policy.

### `[workspace]`

Optional and backward-compatible: omission selects the builtin `git-worktree`
provider. The selector envelope is strict; only `[workspace.config]` is an open,
plugin-owned table.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `provider` | `"git-worktree"` | nonblank builtin or plugin-registered name | Selects the one provider used by dispatch, recovery, PR polling, and cleanup. |
| `config` | `{}` | open nested table; must be empty for `git-worktree` | Passed unchanged to the selected plugin factory. |

A selected plugin factory receives the nested config, process environment, and
absolute repository root. Unknown names fail before claims and list all
available providers. A handle's `path` is absolute in its execution environment,
`ref` is provider-scoped, and optional `localPath` alone promises dispatcher
reachability.

`provider = "vercel-sandbox"` runs the complete build in a persistent Vercel VM
and requires an HTTPS hosted Store/scoped token, GitHub HTTPS origin, GitHub
forge, a dispatcher-side push-capable `GITHUB_TOKEN` or `GH_TOKEN`, and either
`VERCEL_OIDC_TOKEN` or the `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/
`VERCEL_PROJECT_ID` tuple. These credentials are validated before claims:

```toml
[workspace]
provider = "vercel-sandbox"
[workspace.config]
timeoutSeconds = 2700
image = "vercel/sandbox/universal:latest"
vcpus = 4
environmentVariables = ["AI_GATEWAY_API_KEY"]
# private repository only; dedicated contents-read/no-write identity:
gitUsernameEnv = "AB_GIT_READ_USER"
gitPasswordEnv = "AB_GIT_READ_TOKEN"

[workspace.config.runtimeProvisioning.pi]
install = "npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.4"
preflight = "test \"$(pi --version)\" = \"0.84.4\" && pi update --models"
```

`timeoutSeconds` is required (60–86400; Hobby currently caps at 2700), `vcpus`
is 1–32, and optional `region`/unique `failoverRegions` select placement. Only
the named runtime variables and scoped `AB_STORE`/`AB_TOKEN` enter guest
commands. Never list Store, Forge, Vercel, or private-clone credentials there.
Every effective primary/alternate runtime needs a strict
`runtimeProvisioning` entry with pinned `install` and exact-version `preflight`
commands; runtime names remain open for plugins. Install/preflight runs before
the marker in every fresh/replacement/readiness sandbox, and preflight reruns
before every child. Failures name the runtime, role/alternate, and field and
start no agent. Keep runtime installation out of `commands.setup`. Pi over
`vercel-ai-gateway/...` uses `AI_GATEWAY_API_KEY`; never copy OAuth tokens,
`~/.pi`, or interactive login state. The clone identity is upload-pack-only and
scrubbed from Git config before an agent starts. Agents cannot push. Remote phase terminals deposit a durable
publication request and park; that successful `ab done` is the one terminal and
must not be repeated. After VM stop and lease release, the local kernel
publishes the exact SHA/branch through a temporary narrow firewall transform,
verifies it, and performs PR work locally. Ordinary completion deletes the VM.
Branch config, installed skills, relative/package plugins, setup, and phase CLI
commands resolve from the guest checkout, never dispatcher paths.

### `[commands]`

An **open map** of name → shell string. Both the key and the value must be
nonempty strings. Keys are user-chosen: `setup`, `lint`, `type-check`, and
`test` are *conventions*, not required keys, and a repo may define any verb it
likes.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `<name>` | — | nonempty string → nonempty shell string | Names a deterministic verb the kernel may run. Referenced by name from check steps in `[verify.<step>]` or `[finalize.<step>]`. |

`setup` is special by convention: it runs after workspace provision and after a
sandbox rehydrate. Failures are durable, remain visible in build status and the
dashboard, and retry up to `[policy].maxSetupAttempts`; exhaustion raises a
setup-targeted escalation without manufacturing a pipeline phase or verdict. A
human answer re-arms the budget, and a later successful `runner.attached` clears
the current error. Values are never evaluated as config — they are handed to a
shell as written.

Fresh init config deliberately leaves this map empty. The setup agent follows
the installed [repository setup reference](references/setup.md), derives commands
from the repository's actual toolchain, and asks the user about choices source
cannot answer; deterministic init code never guesses a language or package
manager.

Setup configures an **acceptance check** in every repository: a repository-owned
agent verify step that runs the built software, exercises each acceptance
criterion in the spec, attaches evidence, and returns a typed verdict. It is
not a test suite and leaves no test files behind. Wire an existing maintained
end-to-end or browser test suite into an ordinary `check` step. If none exists,
do not create one during setup. The acceptance check neither substitutes for
nor seeds a suite.

### `[verify]`

Post-reconcile verification defaults to enabled: `[verify].afterReconcile = true`.
Set it to `false` to retain pre-reconcile verification and skip all steps after
reconciliation. An optional boolean `[verify.<step>].afterReconcile` overrides
the repository setting in either direction; overrides require a configured step.
For example, set `afterReconcile = false` in `[verify]` and
`afterReconcile = true` in `[verify.types]` to keep only that step re-running.

The kernel freezes the resolved ordered policy in
`verify.reconcile-policy-captured` at the next engine action after reconcile
completion. A cycle already started keeps its policy through recovery.
Configuration supersession starts a fresh cycle and captures a new policy for
its configured universe, retaining the original reconcile identity. Historical cycles already started
without a captured policy retain the rerun-all behavior. Initial verification
and verification after subsequent code review always use ordinary applicability.
Policy exclusion precedes plan selection and paths, including `always = true`.
Enabled steps still follow plan selection and path rules. Excluded steps record
`verify.completed` with outcome `skipped`, `skipCause = "post-reconcile-policy"`,
and a reason naming the setting. Dashboards and PR summaries call this
"skipped by post-reconcile policy"; it is never a pass. Forge-side required
checks and branch protections still gate merge. For excluded steps, merged code
is not re-verified, so breakage that only exists in the combination can merge.


`steps` orders stages: a name is a singleton, an array groups concurrent
members. Every name becomes a `verify:<step>` phase with its own table. Those
subtables are part of this section — their fields are listed here.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `steps` | `[]` | strings or nonempty arrays of names; no duplicate names | Ordered stages. Members start together; every pass or skip is required before the next stage. Each name needs a matching table. |
| `failFast` | `false` | optional boolean on either verify kind | A failure cancels unfinished members of its stage, then tears down and relaunches the whole execution before implement. |
| `kind` | — | **required**, `"check"` \| `"agent"` | Discriminator. `check` is deterministic (command + pass/fail, never an agent); `agent` runs a skill that returns `pass`, `fail`, or `skip`. |
| `command` | — | **required when `kind = "check"`**, nonempty string | Ref into `[commands]` — the key, not a shell string. Pass/fail is the command's exit status. |
| `skill` | — | **required when `kind = "agent"`**, nonempty string | Installed skill name to run (e.g. a repository-authored `"verify-acceptance"`). |
| `paths` | — | optional nonempty array of positive repository-relative globs | Makes either step kind apply when any changed path matches any selector. Omitted means unconditional. |
| `afterReconcile` | repository: `true`; step: inherited | boolean | Step override wins over `[verify].afterReconcile`; false skips this step after reconciliation only. |
| `always` | — | optional boolean | `true` makes the step unconditional and mandatory (a plan cannot deselect it); `false` is equivalent to omission. |

### Choosing verify stages

Run cheap gates early, and put deterministic checks before agents. Agent runs
spend model budget, and an agent examining software that cannot build can produce misleading reports. Group
independent failures to collect useful reports in one round trip. Keep steps
that share mutable ports, databases, output directories or caches apart unless
they are isolated; if they cannot run together in a developer terminal, they
cannot run together here. CPU demand multiplies by build `capacity`; no cap
limits stage size, so configuration is the entire concurrency budget.

Use `failFast` when a failure invalidates sibling results, or when a failing
step usually finishes much sooner than its siblings. Waiting costs the chance
of this failure multiplied by siblings' remaining time; it saves the chance of
an independent sibling failure multiplied by an implement/review/reverify round
trip. Decide using actual failure and duration history, including checks that
implementers already run before `done`. Give every agent its own inputs through
`$AB_CONTEXT_DIR`, never fixed `.ab/` paths; concurrent verifiers share the
workspace, not their context directories.

Default failure waits for all siblings, including an escalated verifier's
answer and rerun. Fail-fast cancellation supersedes only that occurrence's
agent escalation, including late raises/answers; it is no longer answer-required
and never delivers guidance into another occurrence. A cancelled member is not
run, never passing evidence. Whole-execution teardown and replacement add a
relaunch cost but prevent cancelled descendants from writing during implement.
Restart reruns only members without outcomes, keeping the same attempt and every
recorded outcome. One failed cycle spends one verify-attempt unit.

`verify.stage-failed` is the decisive full-feedback receipt. The legacy
`feedback.verify` object still names the first failed report; the implement
manifest also lists all reports and not-run cancellations through its receipt
reference, including on guidance rounds. Rounds without a referenced receipt
have no cancellation list. Finalize receives historical reports but no
`cancelledVerify` list; its evidence is the satisfied current cycle.

A plan may begin with strict TOML front matter selecting the complete set of
optional verification it warrants:

```toml
+++
verifySteps = ["types", "acceptance"]
+++
```

Names must already exist in `[verify].steps` with matching tables; duplicates,
blanks, unknown names, malformed metadata, and omission of an `always = true`
step make the planner's `ab done` fail before `plan.completed` is appended.

Repository-authored verify and finalize skills must run `ab context`, then read
`"$AB_CONTEXT_DIR/context.json"` and the inputs under `$AB_CONTEXT_DIR`.
Materialized keys are directory-relative; manifest path fields are workspace-relative.
Scratch output, downloaded references, probes, and temporary scripts belong under `.ab/`
(prefer the current `$AB_CONTEXT_DIR` when appropriate), never at the worktree
root, and must not be committed. Manifest-directed artifact paths remain authoritative.
Keep concurrent verifiers in their distinct context directories.

An agent verify step is handed the build's pinned ticket assets under
`$AB_CONTEXT_DIR/assets/` (listed in `$AB_CONTEXT_DIR/context.json`) as well as the spec. A verify skill
should treat a `design` asset as part of the contract, a contract on observable
visual and reference outcomes, not on implementation, and judge the result
against it.

Node `verify:*` context additionally exposes `nodeVerification`: the frozen
range, a JSON index path, contribution build slugs, preparation-time stored ticket
identities, event-authorized spec revisions and spec paths, and their commits.
The index maps every commit in the range using build identity trailers,
including earlier-cycle contributions and merge side history. Commits without
an identity are listed as unattributed (a mechanical classification). The manifest
and index also expose `handPushedCommits: [{sha, originalSha, message}]` for owned
hand-pushed commits in the frozen range, preserving original identity across restacks.
Their full messages express maintainer-authorized intent: judge quality and
consistency, and never fail them solely for lacking a covering spec. Other node
changes are authorized when covered by the node spec or the spec
of the contribution introducing it; use the commit mapping to find that spec.
The dispatcher collects these inputs with repository authority before launching
verification and atomically deposits a node-owned `node-verification-context`
artifact cited by exact revision in `integration.prepared`. Contributor specs
freeze at preparation; resumed and concurrent verifiers read the same cycle input.
Hydration reads only that node-owned artifact and grants no general contributor
read authority. Missing or ambiguous provenance prevents preparation; missing,
corrupt or mismatched prepared inputs fail hydration. Historical agent cycles
without a citation require a new integration cycle. Leaf context is unchanged.

An agent verify step selects `[roles.<step>]` by its **logical step name** —
the name in `[verify].steps`, not the skill it runs. An agent finalize
post-step follows the same rule.

```toml
[verify]
steps = ["acceptance"]

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance" # repository-authored skill

[roles.acceptance]        # the STEP name — not "verify-acceptance"
runtime = "pi"
model = "openai-codex/gpt-5.6-sol"
```

The step's configured skill name remains a deprecated alias for existing
configurations and will be removed in a future release. It applies only when
`[roles.<step>]` is undeclared, so the step name always wins when both are
present, and `ab dispatch` reports the alias with the step name to rename it to.
Written order never reorders execution: the event records the canonical config
order. No front matter means all configured steps, preserving old plans and
logs; an explicit empty list is valid only when all steps are optional. The
selection from the exact plan completion approved by `plan-review` is
authoritative. A spec restart replaces it with the newly approved plan; a
reconcile reuses it.

If the approved selection later names any step absent from the cycle's pinned
configured universe, the entire selection falls back to all configured optional
steps. The kernel records one observation per cycle and plan revision naming
the unknown steps. Mandatory steps, path applicability and post-reconcile policy
still apply. A valid selection continues to skip genuinely omitted optional
steps. Strict validation when depositing a new plan is unchanged.

Cross-field rules the validator actually enforces — each is an **error**:

- A step listed in `steps` with no `[verify.<step>]` table.
- A `[verify.<step>]` table whose step is not listed in `steps` (add it to
  `steps` or remove the table — a defined-but-unlisted step never runs, so this
  is never silently tolerated).
- `command` naming a key that does not exist in `[commands]`.
- An empty or malformed `paths` list. Matching is case-sensitive over Git's
  `/`-separated paths; supported syntax is literals, `*`, `?`, and `**` only as
  a whole segment. Absolute/traversing/empty segments, negation, escapes,
  character classes, brace expansion, extglobs, and malformed `**` are errors.
  `always = true` does not hide selector errors.

For each step, the kernel evaluates the approved plan selection first, then
`paths`: both must include the step for it to run. A selection exclusion records
`excluded by approved plan selection (plan@<rev>): verify step "<step>" was not selected`.
A selected step's `paths` are evaluated immediately before the step against
current `HEAD`, relative to the initial branch-cut SHA or the refreshed base
from the latest completed reconcile. It uses a NUL-delimited, no-rename Git diff, so
adds/modifications/deletions and both rename sides participate. A reconcile
starts a fresh cycle and evaluation repeats for policy-enabled steps; upstream-only merged paths are
excluded while build-owned resolutions remain visible. A miss starts no
command, agent, or session and records `skipped` with
`excluded by [verify.<step>].paths: no changed path matched <JSON paths>`.
Git/base failures fail closed as infrastructure rather than becoming skips.

Agent verifiers may also use `ab verdict pass`,
`ab verdict fail --report <file>`, or `ab verdict skip --reason <text>`. The
skip reason is required and
must be non-blank; no failure report is required. Either kind of skip satisfies
that step for the current cycle and advances, but it is not a pass and never
masks another step's failure. For leaves, failures return the build to `implement` and
consume `[policy].maxVerifyAttempts` once per distinct failed cycle since the
latest spec revision. Passing target-movement cycles cost zero; cycle identifiers
remain monotonic across restacks and reconciles. Skips retain the cycle's attempt number
without consuming that budget.


Classified session deferrals consume no phase failures. Unsupported decisive
facts retain the mixed-version wait gate and durable compatibility diagnostic.
During an accepted drain, an unsettled build-log authorization suppresses restart
attention only for the exact predecessor runtime and execution instance. The old
runner records relaunch intent when the accepted target is known and exits
without crossing the decisive-fact fence; a later execution never inherits
authorization.
When the scoped `ab context` initial own-build read fails, the CLI best-effort
writes `session.build-read-failed` with exact session, phase, round, operation
`context`, reason `own-build-read`, and diagnostic. A valid terminal from that
session wins if the agent recovers. Otherwise settlement records `phase.deferred`
and `phase.deferral-escalated`, immediately projecting ordinary blocked attention.
The raise cites `own-build-read:<evidenceSeq>`; replay repairs either settlement
crash gap before launching another agent. An `escalation.answered` retry or
guidance authorizes one fresh session without resetting genuine phase failures;
a new classified failure parks again. There are zero automatic paid retries
after this deferral. If evidence cannot be written, ordinary recovery applies;
agent output and `no-terminal` alone never classify a read failure.

Ordinary silence, provider failures and session timeouts retain the runner's
phase failure limit (`BuildRunnerOpts.maxPhaseAttempts`, default 2). This is
an internal runner option, not an accepted `[policy]` TOML key. Reconcile
execution and unchanged-base progress budgets retain their existing accounting.

### `[finalize]`

`steps` orders the post-PR actions; every name requires a matching
`[finalize.<step>]` table. Finalize has its own narrow union: verify-only
`paths` and `always` fields are errors.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `steps` | `[]` | array of nonempty step names | Ordered post-steps that run after the PR is opened. Each name must have a matching table. |
| `kind` | — | **required**, `"check"` \| `"agent"` | Selects deterministic command execution or an agent skill. |
| `command` | — | **required when `kind = "check"`**, nonempty string | Ref into `[commands]`. The kernel runs the resolved shell command in the workspace with no agent session. |
| `skill` | — | **required when `kind = "agent"`**, nonempty string | Exact installed skill name passed to the runtime; no implicit `ab-` prefix is added. |

```toml
[finalize]
steps = ["publish", "release-notes"]

[finalize.publish]
kind = "check"
command = "publish"

[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"
```

The logical step name selects `[roles.<step>]` for agent routing — the same
rule an agent verify step follows, so one convention covers both:

```toml
[verify]
steps = ["acceptance"]

[verify.acceptance]
kind = "agent"
skill = "verify-acceptance" # repository-authored skill

[finalize]
steps = ["release-notes"]

[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"

[roles.acceptance]              # verify STEP name — not "verify-acceptance"
runtime = "pi"

[roles.release-notes]    # finalize step name
runtime = "pi"
```

For an agent *verify* step, the step's configured skill name remains a
deprecated alias for existing configurations and will be removed in a future
release. Finalize has never had such an alias.

Checks
write their completion and any follow-up with kernel attribution; agents retain
their session actor and transcript. Nonzero command exits, execution/launch
exceptions, and structured agent failures all produce `ok = false` plus a
follow-up observation. Either `ok = true` or `ok = false` drains the step, so
neither kind can turn an otherwise green build red.

Validation rejects a listed name with no table, a table whose name is not in
`steps`, a check command absent from `[commands]`, an unknown kind, or any
field outside the selected strict variant. Diagnostics name the logical step.

A post-step that produces repository content must select and commit its files
locally and leave a clean worktree. The runner proves the last published head
is an ancestor and performs the regular, non-force push through the Forge port
of the frozen SHA, confirming exact authoritative readback;
the agent never pushes. An unchanged `HEAD` creates and pushes no commit. Dirty
output, rewritten history, Git errors, and publication failures record the
step as failed and file an observation while the green build continues.

### `[roles]`

An **open map** of role name → `{ runtime?, model?, args?, extensions?, sessionBudgetSeconds?, alternates? }`.
The three primary axes, session budget, and ordered alternate list inherit independently. The reserved `default` role must explicitly name a
runtime, is the raw inheritance base for every other role, and is **never
dispatched as a phase**. Its absence fails eager resolution before a session,
with a copyable fix and all registered runtime names. Three runtimes ship:
**`claude`** (local Claude Code CLI), **`codex`** (local Codex CLI; unqualified
`gpt-*` ids), and **`pi`** (local Pi CLI 0.84.3 or newer; provider-qualified ids
such as the independent `openai-codex/gpt-5.6-sol` route). Pi runs headlessly
through RPC and uses that local installation's login and model catalog;
Autobuild does not install it. `ab models [query]` lists the local catalog, and
`ab models --available` filters it to configured credentials. Claude and Codex
delegate an omitted model to their CLI default; Pi declares `kimi-coding/k3`.
Trusted plugins may register additional runtime names;
they use the same role inheritance, default-model compatibility validation,
session event attribution, and optional one-shot capability path as builtins.

The pipeline resolves `plan`, `plan-review`, `implement`, `code-review`,
`finalize`, and `reconcile`, plus each **agent** verify and finalize step by
its logical step name. A verify step's configured skill name remains a
deprecated alias for existing configurations and will be removed in a future
release. The repository workflow resolves `harvest` and `harvest-review`. Two
non-phase judgments use the same runtime/model/args resolver: `slug` optionally
proposes pre-build naming, and `upgrade` proposes a resolution only when a
vendored skill merge conflicts. Both are tool-free one-shots and receive the
role's effective `args`. Missing slug capability uses the deterministic title fallback;
unavailable upgrade judgment retains the conflict for manual resolution.

A declared key that none of those routes requests is resolved and validated
like any other, and then never used — `ab dispatch` reports it at startup,
naming the key and the keys valid for this configuration, and reports a
deprecated skill-name key with the step name to rename it to. Both stay
warnings; neither blocks a session or changes which runtime and model run. A
`kind = "check"` step starts no session and so is not a route: naming a role
after one does not make it consumed. It is reported only when that check step is
its sole apparent route — a check step named `plan` leaves `[roles.plan]`
consumed by the core `plan` phase, and nothing is reported.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `runtime` | — | required on `default`; otherwise optional, nonempty string | Runtime for this role. A child that omits it inherits `[roles.default].runtime`. Must name a registered runtime. |
| `model` | — | optional, nonempty string | Model for this role. A role that omits it inherits `[roles.default].model`; only when neither names a model does the merged runtime supply its own default. |
| `args` | `[]` | optional, array of nonempty strings | Ordered extra CLI argv tokens for every phase and tool-free one-shot invocation. Omitted ⇒ inherit `[roles.default].args`; a set list, including `[]`, replaces it wholesale. Each string is one token, without shell parsing. Only model and parsed protocol/output-mode spellings are rejected eagerly. |
| `extensions` | no effect | deprecated optional array of nonempty strings | Compatibility-only field. Dispatch warns for each declaring role and directs migration to `args`. |
| `sessionBudgetSeconds` | policy fallback | optional positive integer | Active-time budget for each build phase session on this logical role; suspended intervals are excluded and native continuation retains the original ceiling. Omitted ⇒ inherit `[roles.default].sessionBudgetSeconds`; absent there too ⇒ `[policy].sessionBudgetSeconds`. One value covers the primary and every alternate. |
| `alternates` | `[]` | optional ordered array of strict `{ runtime?, model?, args?, extensions? }` entries | Failure-triggered targets. Omitted ⇒ inherit `[roles.default].alternates`; a role list, including `[]`, replaces it wholesale. Each entry overlays that role's effective primary axes and is eagerly validated. `extensions` remains only the deprecated no-op. |

Inheritance is mechanical and **independent per field**: merge each configured
role over the raw `default` entry, then validate the exact runtime/model pair.
The named runtime must serve the named model. A model-only role never searches
for another runtime, and an incompatible inherited model is never replaced by
the selected runtime's default. The one implicit fill-in is benign: if neither
the phase role nor `default` names a model, the merged runtime uses its own
default model. Compatibility failures name the role, runtime, model, and served
model families; all problems in `default` and every declared role are
aggregated by one eager resolver construction before judgment runs. Runtime
adapters reject only the model and parsed protocol/output-mode options they
emit: Claude rejects `-p`/`--print`, `--output-format`, and `--model`; Codex
rejects `--json` and `--model`/`-m`; Pi rejects `--mode` and `--model`. Exact
spellings, `--option=value` forms, and documented compact short aliases join
that same role-naming aggregate. Every other option passes through without
Autobuild validation, including sandbox, approval, session, tool, skill,
thinking, extension, lifecycle, and unknown options, even when it supplements
another adapter-emitted occurrence. Pi always
disables ambient extension discovery and explicitly loads the Autobuild bridge;
`--extension <path>` in `args` loads an explicit extension alongside it and
activates all tools that extension registers. With no such args, Pi loads no
operator-installed extensions. Effective args are recorded on session-start
facts. Dispatch
constructs it before any build launches; upgrade constructs it lazily on the
first conflict and converts a construction failure to the safe `conflicted`
outcome.

Each attempt starts from the primary. Overload, rate-limit, 5xx, timeout,
transport, unknown provider failures, and quota/usage/billing exhaustion try
alternates in order without consuming extra phase attempts. Authentication,
permission, and local runtime-configuration failures do not. Every target has
its own session/transcript; a continuation fallback starts fresh from durable
context. Selection is not sticky, so the next phase, continuation, or retry
starts from the primary. A suspended Harvest turn first retries its recorded
route, then tries the remaining configured targets in order. Its substitution
and failure evidence retain configured indexes even when that order starts at
an alternate; only a successful primary can remain live for producer revisions.
Only chain exhaustion writes the phase failure, and
the final failure controls retry behavior. Substitution starts and exhausted
failures retain the targets and verbatim errors durably. Core phases, agent
verify/finalize, and Harvest use the chain; tool-free one-shots do not.

A build phase session that reaches its captured budget is aborted and ended
best-effort. The kernel records retryable `phase.failed` with `phase session
budget expired after <seconds> seconds`, retries from the primary under the
existing phase-attempt cap, and raises an answerable policy escalation when
exhausted. Kernel expiry never selects an alternate. Operator cancellation does
not disable the captured deadline: cooperative adapters return promptly, while
the deadline releases a turn that ignores cancellation. If operator abort
arrived first, that release remains an abort control outcome with no alternate
or `phase.failed`. A typed terminal racing either boundary remains authoritative.
Agent finalize post-step expiry is failure-tolerant; Harvest and direct check
commands are outside this budget.

Mixing models across roles is **intentional**, not an inconsistency to clean
up: a reviewer that differs from the implementer catches more. The removed
legacy `[agent]` table is not an alias: config loading rejects it and directs
users to move its fields to `[roles.default]`.

### `[policy]`

Every field is a **positive integer** except `harvestMaxDrift`, which is a
nonnegative integer so zero can disable that trigger.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `upgradeDrainSeconds` | `900` | positive integer | Local generation drain deadline from handoff start; hot-reloaded while draining. |
| `sessionBudgetSeconds` | `3600` | positive integer | Active-time bound for each build agent session unless its logical role overrides it; native continuation retains accumulated time and excludes suspension. |
| `stallRounds` | `3` | positive integer | The same finding surviving this many review rounds auto-escalates to a human — the anti-loop guard. |
| `maxVerifyAttempts` | `3` | positive integer | Caps distinct failed verify cycles since the latest spec revision; passed and skipped cycles cost zero. |
| `maxDispatchAttempts` | `3` | positive integer | Caps consecutive dispatch failures before a setup-targeted `dispatch-failure-limit` escalation. |
| `maxSetupAttempts` | `3` | positive integer | Caps consecutive `[commands].setup` failures before a setup-targeted human escalation. |
| `maxInfrastructureAttempts` | `3` | positive integer | Caps consecutive remote provider lifecycle failures before a setup-targeted human escalation; a `retry` answer re-arms the budget. |
| `maxReconcileAttempts` | `3` | positive integer | Caps completed reconciles that leave the PR conflicted against an unchanged authoritative base. Moving-base races do not consume the budget. |
| `maxReviewRounds` | `6` | positive integer | Default `maxRounds` for the `plan ⇄ plan-review` and `implement ⇄ code-review` convergence loops. When that cap parks a build, `ab answer <slug> --review-round-ceiling <n>` may replace it for only the escalation's loop and current spec revision. |
| `harvestThreshold` | `5` | positive integer | Newly unclaimed `observation.recorded` occurrences required to start one repository harvest run. |
| `janitorFailureAttentionSeconds` | `600` | positive integer | Consecutive janitor failure duration before build attention. |
| `nodeIdleAfterSeconds` | `600` | positive integer | Quiet period before opened integration nodes enter idle polling. |
| `nodeIdlePollSeconds` | `120` | positive integer | Interval between idle node checks; durable activity wakes the next tick. |
| `janitorBackoffMaxSeconds` | `300` | positive integer | Cap on exponential janitor retry delay, starting at 30 seconds. |
| `harvestMaxDrift` | `3` | nonnegative integer | Other builds merged after the oldest unclaimed observation required to start a run; `0` disables drift. |

Dispatch failures share one budget across stages until runner attachment. At
exhaustion dispatch parks durably; bare `ab answer <slug>` and text guidance
both grant a fresh budget, while abort terminates without retrying. Workspace
failures owned by provider infrastructure recovery use only its existing budget.

The dispatcher also applies a fixed, non-configurable limit of three consecutive
executions that complete normally with exit code zero and no durable build
progress. Execution start/end, runner attachment and workspace lifecycle
bookkeeping do not count as progress. Pipeline, session, spec, publication/PR,
observation and acknowledged operator facts reset the streak; infrastructure,
budget and provider failures do not consume the allowance and retain their own
retry limits. Phase-boundary relaunch outcomes consume no allowance or failure
budget and raise no attention. Before a fourth actionable launch, the dispatcher raises one
setup-targeted `execution-no-progress` policy escalation naming the count and
the next action it expected the runner to take. Waiting, paused and terminal
builds are left parked, and pending operator commands remain executable.
Answering that escalation with guidance or a bare `ab answer <slug>` retry grants
three fresh executions. The guard is derived from durable facts, including on
supervisor restart, and uses the ordinary watch, dashboard and operator API
attention paths.

For each repeat conflict, Autobuild compares the target base of the latest
completed reconcile with a fresh authoritative base snapshot. An advanced base
proves the attempt lost a race and permits another reconcile regardless of the
attempt high-water. An unchanged base consumes `maxReconcileAttempts` and
escalates when the budget is exhausted. Ordinary current policy escalations carry
a closed `policyCause`; `phase.deferral-escalated` instead identifies an
own-build-read deferral and its answer resets no phase failures; reconcile no-progress uses `reconcile-no-progress`,
while `round` remains occurrence scope. Answering a runner-failure cause re-arms
only its matching phase and round. The phase-level `verify-failure-limit` cause
explicitly re-arms all rounds for its verify target, while
`reconcile-no-progress` and the setup-only cause reset no phase-runner failures.
The closed cause map forces every future policy condition to choose one of these
semantics instead of inheriting behavior from a missing `round`. Runner failures
while checking progress or refreshing the base therefore remain counted after a
roundless no-progress answer. An already exhausted no-progress budget raises its
matching cause separately before another reconcile. Cause-less historical
raises retain their former round-shaped reset behavior, and roundless
policy/reconcile raises retain their former no-progress meaning, on replay
without migration. Post-reconcile verification follows the captured policy and remains
independently bounded by the distinct failed-cycle count in `maxVerifyAttempts`.

`stallRounds` counts *persistence chains*, which reviewers mark and the kernel
only follows. A finding's `persists` ids name prior-round findings whose defect
is still present in the work under review; a new instance of a defect class
whose reported instance was fixed is fresh work and starts its own chain,
however closely it resembles its predecessor. So the counter measures a
producer/reviewer stalemate rather than a defect category the loop keeps
converging on, and the kernel decides only whether a marked chain has survived
the threshold — never whether two findings are the same disagreement.

Harvest is driven by pressure inside `ab dispatch`, not by a wall clock, and
remains independent of build `capacity` and repository intake. Count reaching
`harvestThreshold` or drift reaching `harvestMaxDrift` starts a run. Drift is
measured from the oldest unclaimed observation and counts distinct later
same-repository merges from other builds; aborted and closed-unmerged builds do
not count. Once either limit is reached, the run claims the whole current
accumulation. Dispatch
tracks it without blocking watch ticks; a repository lease provides
cross-process single-flight. Recovery has its fixed per-run two-attempt budget,
separate from the configurable policy fields above.

### `[tickets]`

Names the TicketSource and owns its readiness/lifecycle state vocabulary.
Declarative only. The table is required: `readyState` has no default, and an
absent table fails clearly at `tickets.readyState` rather than making every
state eligible.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `source` | — | **required**, nonblank builtin or plugin registration name | Which provider backs all ticket operations. Unknown names report every available builtin and plugin source. |
| `readyLabels` | — (source-aware) | optional; array of nonempty strings | A ticket must carry **every** listed label to be dispatchable. `[]` = **no label gate**. Absent uses the source default below. |
| `url` | selected build service | HTTPS URL (loopback HTTP allowed), no userinfo/query/fragment; hosted only | Ticket service independent of builds; required for local builds. |
| `readyState` | hosted: `ready` | non-blank string; required for other sources | The one workflow state a ticket must sit in to be dispatchable. Linear matches exactly and case-sensitively; file matches it case-insensitively to a state directory (`ready` → `ready/`). There is no any-state mode. |
| `readyAssignee` | — | optional; `"me"` or an email; `linear` only | Also require the ticket to be assigned to that Linear user (`me` = owner of `LINEAR_API_KEY`); unassigned tickets are never ready. |
| `teamKey` | — | required by `linear` and `hosted`, forbidden by `file`, allowed for plugins | The Linear team key (e.g. `"ENG"`), the captured prefix for new hosted ticket ids (`ENG-1`), or a plugin configuration field. Hosted numbers are project-local and continue across prefix changes; legacy ids remain aliases and readable inputs are case-insensitive. |
| `claimedState` | — | optional nonempty string; forbidden by `file`, allowed for plugins | Workflow state `claim()` moves a ticket to when a build starts. |
| `doneState` | hosted: `"done"` | optional nonblank string | Project completion state and merged-ticket transition; hosted tickets only. |
| `createState` | — | optional, nonempty string | Default state for new tickets when a create does not name one. Absent = the provider's default (Linear: the team's default, e.g. Backlog; file: Triage). |
| `triageState` | — | optional, nonempty string | State the dispatcher hands tickets back to for human triage — spec-gate bounces, aborted builds, closed-unmerged PRs. Absent = Linear: Backlog; hosted: triage; file/plugin: Triage. Must name a state the tracker actually has — a Linear team only has "Triage" when its triage feature is enabled. |
| `proposalState` | — | optional, nonempty string | State observation harvest files approved proposals into. Absent = the resolved `triageState`, which keeps the human grooming gate. Setting it to `readyState` waives that gate: harvested proposals dispatch without being read. Keep it distinct from `triageState` — see below. |
| `dir` | file: `.autobuild/tickets`; plugin: — | optional nonempty string; forbidden by `linear`, allowed for plugins | Root holding file state directories, or an existing plugin configuration field. |

`readyLabels` is the only source-aware readiness default. Dispatch resolves it
as follows:

| `[tickets].source` | `readyLabels` absent |
|---|---|
| `"linear"` | `["autobuild"]` — the historical label narrowing |
| `"file"` | `[]` — no label narrowing; `readyState` selects the directory |
| plugin | `[]` — no host-imposed label convention |

An explicit `readyLabels` value always wins for every source.

`proposalState` is the one supported way to waive the grooming gate, and it is
deliberately not `triageState`. Do not suggest pointing `triageState` at the
ready state to get auto-dispatched proposals: `triageState` is also where a
spec-gate bounce merges, so a nonconforming ticket would be claimed, bounced,
and reclaimed on every tick. `proposalState` moves only what harvest files.

Cross-field rules, each an **error**:

- `source = "linear"` without `teamKey`; or with `dir` set.
- `source = "file"` with `teamKey` or `claimedState` set. `dir` is **optional**
  here — absent means the default above, which is why the schema leaves it
  optional rather than giving it a `.default()`: that is what keeps the
  linear-only rule above meaningful and lets the factory tell a defaulted `dir`
  from an explicit one.
- Every other name is plugin-selected after loading. The factory receives the
  existing ticket table, environment, and absolute repository root; no untyped
  plugin-options table is added. The selected dispatch instance serves
  readiness, dependencies, claim, comments/transitions, harvest creation, and
  janitor completion. Every source-agnostic `ab ticket` command loads and uses
  the same configured registration.

The file tracker is **directory-per-state**: `<dir>/<state>/<id>.md`, where
every directory directly under the root is a state: the four lifecycle
directories `triage/ ready/ doing/ done/` (always present, created on first use)
plus any others the repository adds, such as `icebox/`. A state exists when its
directory exists; state names match directories case-insensitively, and a name
with no directory is an error listing those that exist. The directory *is* the
state, so a transition or
claim is a rename — frontmatter carries no `state`/`claimedBy`, and a ticket
body survives byte-exactly because a move never rewrites the file. A malformed
record in any state directory is diagnosed with its path and validation
problem, left untouched, and excluded from listing/claim so unrelated valid
ready work can continue. `ab ticket list` sends those diagnostics to stderr and
keeps JSON stdout as one bare valid-ticket array. Tracker-wide safety checks
remain fatal: the same id in two state dirs is a loud error naming both paths,
as are root-level ticket files with no state and filesystem failures. When
`dir` is defaulted, the backlog writes its own `.gitignore` of `*`, so git never sees it; an
explicit `dir` is the user's and is left alone. Operator agents and humans drive it
through the source-agnostic `ab ticket` commands rather than running `mv` or
`mkdir` by hand; `ab ticket state create` makes a new state.

**Secrets never live in this file.** `LINEAR_API_KEY` and plugin-declared
`requiredEnv` credentials are environment variables (a local `.env` works).
Missing plugin credentials name both the selected source and every missing
variable. If a user asks you to put an API key in `autobuild.toml`, use the
environment variable instead and say why.

### `[orchestrator]`

Enables credential-free sandbox environments per session owner and repository,
driven by external agents through `sandbox.*` tools. Operators run in external
harnesses; the service never starts or resumes them. The table is strict and
restart-classified.

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `enabled` | `false` | boolean | Enables external sandbox tools, archive cleanup and dispatcher idle settlement. |
| `sandbox` | — | strict subtable | The sandbox behavior knobs; absence reads as the defaults below. |

The removed runner settings `model`, `invocationBudgetSeconds`, `approvals` and
repository-default `wake` are rejected in new config. Historical effective
config artifacts remain readable. New sessions have no inherited wake settings;
explicit session wake writes are durable facts and do not execute turns.

`[orchestrator.sandbox]` fields:

| Field | Default | Allowed / constraints | Effect |
|---|---|---|---|
| `idleMinutes` | `30` | positive integer | Minutes without a sandbox tool call after which the dispatcher tick's janitor stops the environment, keeping its snapshot; the next tool call resumes it. |
| `environmentVariables` | `[]` | array of nonblank names | Names of non-secret host variables forwarded into the sandbox — the only non-toolchain environment it ever sees, during provisioning/setup and tool exec/start alike. Unset means none. |

The credential-free rule is structural, not advisory: the environment receives
no store, forge, ticket-provider, or model credential, and naming any of
`AB_STORE`, `AB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `LINEAR_API_KEY`,
`VERCEL_OIDC_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, or
`AI_GATEWAY_API_KEY` in `environmentVariables` is a config error. The typed
operator tools remain the only route to build state from inside the sandbox.

Tool bounds an operator agent should know: `sandbox.exec` waits at most **300
seconds**; stdout and stderr are each truncated at **65,536 bytes** with a
`[truncated by autobuild: output exceeded 65536 bytes]` marker; `sandbox.reset`
and archiving a session owner's last session are **destructive** (reset re-provisions
from the current base head); there is at most **one** environment per session owner
and repository.

Publication: `sandbox.publish` takes a title (1–200 characters), an optional
body (≤65,536 characters), and an optional explicit commit, and takes your
sandbox's current head commit to a pull request. It refuses when the checkout
has uncommitted changes — tracked or untracked (the sandbox's own provisioning
marker is excluded) — and when the commit is not a descendant of the base head
recorded when the sandbox was provisioned or last reset — a pre-existing environment without a recorded
base head asks you to run `sandbox.reset` first. The rule is PR only, never the
base branch: the sandbox itself never pushes and holds no credential — the push
and the PR creation are kernel plumbing through the workspace provider's
publication capability, to one deterministic operator branch per session owner and
repository, so a later publish updates the same PR's head. A publication is a
repository-journal fact naming the session owner (the `operator` field), the session, the branch, the
commit, and the PR; a refused or failed attempt is journaled too.

### `[upgrade]`

| Field | Default | Meaning |
| --- | --- | --- |
| `automatic` | `true` | Check and adopt changed runtime targets automatically. |

`[upgrade] automatic` is a strict boolean, defaults to `true`, and hot-reloads.
Resident checkout dispatchers check every 60 seconds, independently of tick cadence.
Exact changed targets can include downgrades. Missing or inconsistent declared-pin
metadata never falls back to installed mode. Self-hosting source launches follow
the authoritative base commit using packaged-content and production-lock equality,
without modifying operator or build worktrees. Equal-content advances still record
the latest resolved target SHA. Compatible generations overlap through the durable draining handoff described above. `--once`, origin/hosted and direct hot
presentation modes bypass automatic adoption. Operator stop wins over cutover.
Repository status exposes per-run resolved target, upgrade target, failure and handoff facts, both
generations, takeover, outstanding draining builds and deadline;
`dispatcher.upgrade-failed` and `dispatcher.runtime-rolled-back` are actionable attention. Status also exposes the last rollback and current-lineage hold. Unrelated base commits do not
retry an unchanged failed target. No registry credentials belong in these facts.

## Setup and upgrades

For 0.x upgrades, first read the [migration reference](references/migration-1.0.md):
merge-policy conversion and resumed-build behavior are part of adoption.

**`ab init <target> [--force]`** runs *outside* build sessions — it takes a
repo path, needs no `AB_*` environment, and is safe to re-run. It:

- Probes every registered runtime and reports whether it is usable, including a
  diagnostic reason. Setup launch selection uses the fixed product order
  `claude`, `codex`, then `pi`; it never depends on repository content or a user
  questionnaire.
- If config is absent, writes a valid stack-neutral skeleton with empty
  `[commands]`, no verify or finalize steps, a valid local ticket gate, and one
  explicit runtime solely as a schema placeholder. It reads no package or
  language manifest and invents no command.
- Vendors 12 skills before handoff, including the locally editable
  [repository setup reference](references/setup.md) in the installed `ab-guide`
  tree. On an interactive terminal it starts the selected coding-agent CLI in
  the target repository with a short prompt to read that reference and
  propagates that process's exit status. The direct child inherits terminal I/O
  but no ambient `AB_*` identity, and creates no build, session, event,
  transcript, or BuildStore record.
- Without an interactive terminal or usable shipped runtime, deterministic
  installation still succeeds. Init prints every probe reason and the exact
  setup prompt for the user to run in a coding agent.
- The setup agent inspects the repository, configures real commands and verify
  steps, independently chooses pipeline role runtimes/models, configures the
  ticket source and environment-only credentials, arranges
  an acceptance check through a repository-owned agent verify skill in every
  repository. Wire an existing maintained end-to-end or browser test suite into an ordinary `check` step. If none exists, do not create one during setup. The acceptance check neither substitutes for nor seeds a suite. It completes `bun ab init --validate`, fixing failures
  and reviewing warnings. The human then starts `bun ab dispatch` and opens
  their operator agent with `ab-operate` to create and groom the first ticket,
  checking presence before taking the role; an existing operator picks up ready work.
- It never overwrites config once the file exists, even with `--force`; a rerun
  launches or prints a prompt that asks the agent to review and improve it.
- Idempotently adds the exact `.autobuild/` rule to the target's `.gitignore`,
  preserving every existing byte/rule and handling a missing trailing newline.
- **Copies each complete canonical skill directory** to
  `.agents/skills/ab-<name>/` — `SKILL.md` plus references/supporting files,
  not links. Every file is **editable**: per-repo customization is the point.
  Unknown repository-local support files are left alone.
- Links `.claude/skills/ab-<name>` → the `.agents` directory, so Claude, Codex,
  and Pi discover **one** editable tree rather than diverging copies. If the
  `.claude/skills` and `.agents/skills` roots already resolve to the same
  directory, that repository-level alias satisfies discovery: no per-skill
  link or legacy `.claude` pristine migration is attempted.
- Records the **pristine** installed tree at
  `.agents/skills/.ab-pristine/ab-<name>/` — repo-versioned, and the per-file
  base for `ab upgrade`'s three-way merges.
- Rewrites frontmatter on install: `name` → `ab-<name>`, and
  `disable-model-invocation: true` on every skill outside the model-invocable
  set (`ab-spec`, `ab-tickets`, `ab-guide`, `ab-operate`).

The final report states `autobuild.toml: written|skipped`, aggregates all skill
counts, names only attention-worthy `kept` and `overwritten` skills, and reports
every runtime probe result. A distinct real `.claude/skills/ab-*` directory is
not mistaken for an alias: init processes the remaining skills, accumulates all
such conflicts with move/remove guidance, skips setup, and exits nonzero. The
interactive path otherwise names the selected setup runtime; the fallback
prints its manual-run instruction and exact prompt. Non-TTY output is plain
text.

**`ab --version`** reports the installed package version, Bun-recorded commit
when available, and plugin API version using local distribution metadata only.
It works outside a repository, needs no config or `AB_*` session, and performs
no network request.

**`ab upgrade <target> [--no-self-update | --version <semver>]`** updates only
when explicitly invoked. By default it resolves the latest published version on
the installation's channel — the npm registry for a registry install, or the
latest full GitHub Release from the repository recorded by a Bun forge install
(including a fork) — installs it with the matching local/global Bun mechanism,
then hands off to that replacement binary. The fresh process therefore supplies both skill
defaults and merge logic. `--version` selects an exact release, including an
older one; `--no-self-update` merges against the installed distribution. Source
checkouts are never mutated and still merge installed skills, even with an
exact selector. For latest, unknown/contradictory provenance and lookup/install
failures warn and continue. For an exact release, mechanism, resolution, or
install failure stops before skill merge. No other command checks for or
installs a release.

A local Bun update changes the dependency in its owning project's
`package.json` and the matching `bun.lock` resolution. An existing global
install changes Bun's global package-manager state instead. Before either can
write, upgrade captures the target repository's Git baseline and carries it to
the replacement binary.

After that distribution decision, upgrade three-way merges every distributed
skill file as *pristine base × local edits × new default*, with a standing bias
toward **the local customization** — upstream is adopted only where it doesn't
collide with what the repo deliberately changed. New upstream files are
delivered; an upstream-removed unedited file is removed, while a customized
copy becomes a preserved repository-local support file.
Outcomes:

| Outcome | Meaning for the repo's files |
|---|---|
| `current` | Local already matches the new default, or the repo's edit stands as-is. Nothing written. |
| `adopted` | Upstream's version taken; pristine advanced. |
| `merged` | Clean three-way merge; live file and pristine both advanced. |
| `resolved` | Merge conflicted; a local-biased agent proposal passed deterministic validation, so that live file was resolved and its pristine base advanced to incoming. |
| `conflicted` | Resolution was unavailable, failed, declined as ambiguous, or failed validation. Both sides of that file stay **byte-untouched** for a human — **conflict markers are never written into a live skill**. |
| `installed` | In the distribution but not yet in the repo — installed fresh, like init. |
| `removed` | A fixed retired distribution skill had pristine provenance and either its unreferenced live tree matched pristine and was removed with its owned discovery link, or its canonical live tree was already missing and obsolete provenance plus any owned dangling link were removed. |
| `kept` | A fixed retired skill was customized, still configured, or unsafe to remove, so its live copy remains local; or an otherwise removable canonical copy was deleted while a user-owned Claude discovery entry was preserved and remains discoverable. Obsolete pristine ownership is cleared. |
| `unknown` | An installed `ab-*` skill absent from the distribution. **Left alone** — local skill additions are legitimate. |

The `removed`/`kept` classifications apply only to the fixed retirements
`ab-setup` and `ab-verify-e2e`. A pristine record proves Autobuild provenance;
a same-named repository-authored skill without one is untouched. Upgrade keeps
a retired skill named by an agent verify or finalize step, and parses config
conservatively so an inspection failure also keeps it. A user-owned
`.claude/skills/<name>` discovery entry — a distinct real directory or foreign
symlink — is preserved byte-for-byte, enters the structured discovery-conflict
report, and makes upgrade exit nonzero even when the corresponding
canonical/pristine trees are retired. A preserved symlink keeps its exact link
text and target. Every terminal classification clears obsolete pristine
ownership, making the retirement report one-time and preventing later link
recreation, resurrection, or re-reporting.

After a conflict-free merge, upgrade makes one local commit by default. It
includes only each reported skill's canonical tree, pristine record, and Claude
discovery path, plus `package.json` and `bun.lock` when this run's local Bun
update wrote those files inside the target repository. A global update adds no
path, and no owned change means no commit. Additions, modifications, links, and
deletions are included; unrelated staged, unstaged, and untracked work remains
untouched. The message identifies `ab upgrade` and lists every byte-changing
skill with its reported outcome. `--no-commit` disables this behavior and is
preserved through self-update handoff. If a replacement child receives the
handoff marker without the pre-self-update baseline — possible when an older
parent launches a newer child — it suppresses the entire automatic commit,
names the cross-version compatibility reason, and leaves all upgrade-owned
changes uncommitted for you. Skill-upgrade results and the report's
existing exit code remain unchanged.

Any content conflict, discovery conflict, pre-existing dirt in an owned path,
non-Git target, changed HEAD/worktree identity, or in-progress merge, rebase, or
cherry-pick likewise suppresses the whole commit with a named warning. If upgrade
cannot snapshot the worktree's Git index, it warns and declines to stage. A
staging or commit failure restores that exact pre-attempt index and reports the
original Git failure without touching merged worktree files. The report's
existing exit code is unchanged; upgrade never pushes or rewrites history.
With automatic upgrades enabled, pinned dispatchers adopt the changed version
once the commit reaches the configured base branch. Installed-mode dispatchers
follow their original installation when its version changes. Source-mode
dispatchers follow packaged changes merged to the base, including canonical skills
shipped by that distribution, without requiring a version bump. A consuming
repository's vendored-skill-only merge does not change the installed runtime.
The successor passes config/store and
protocol-write preflight before yield; compatible generations drain, otherwise
cutover suspends local sessions immediately. Existing runners keep execution leases while the
successor owns repository work. At completed phase boundaries local and remote runners
request relaunch onto the accepted target; the current owner resumes them from
durable state. Remaining local sessions suspend at the hot drain
deadline and resume through their durable session records. After an automatic runtime
rollback, phase work continues on the restored runtime at the next boundary;
unreadable decisive facts defer with attention. The held target waits for a changed
resolved target or a fresh operator launch, independently of store compatibility.

The agent gets a fixed per-file deadline of at least ten minutes. While it is
resolving and stdout is interactive, `ab upgrade` continuously redraws one line
with the skill and file path, elapsed time, and `Ctrl-C to cancel`. Ctrl-C then
aborts only that agent invocation, records the file as the usual byte-preserving
`conflicted` outcome, and continues through later files and skills. Ctrl-C when
no resolution is active retains ordinary process termination. Piped and other
non-TTY output has no indicator, cursor sequences, or changed bytes. Timeouts
and cancellations remain content conflicts with exit zero; only Claude
discovery conflicts make upgrade exit nonzero.

The agent output is only an untrusted proposal. Each merge uses unguessable
labels so marker-looking skill content cannot impersonate that merge's
structure. `ab upgrade` requires a
complete file with every region outside the uniquely labelled conflict hunks
unchanged and in order; `SKILL.md` additionally requires the same namespaced
frontmatter identity. Standard marker lines are rejected in agent-authored hunk
gaps but allowed when already protected as exact clean content. Validation
finishes before either file is written. A rejected proposal remains report-only alongside the marked merge diagnostic;
the CLI prints the exact pristine path to merge by hand. Distinct real Claude
skill directories are a separate discovery-conflict class: upgrade processes
all skills, reports every collision with move/remove guidance, and exits
nonzero, while content-level `conflicted` outcomes retain their exit-zero
contract. Local customization survives upgrades, and divergence is visible
instead of silent.

## Local state and store selection

By default, each Git repository owns one self-contained state tree at
`<main-repo>/.autobuild/`:

- `autobuild.sqlite` — build records, event logs, and repository journals.
- `blobs/` — content-addressed artifacts.
- `worktrees/` — autobuild-created Git worktrees.
- `tickets/` — the default location for the `file` ticket source.

The main checkout comes from Git's absolute repository/worktree topology, not
blindly from the current worktree's top level or the parent of its Git common
directory. Commands run in an autobuild-created linked worktree therefore read
the main checkout's state and file tickets, while submodules and
separate-Git-dir checkouts keep distinct roots beneath their own working trees.
There is no home-directory fallback: a repository with no state tree starts
empty.

Every command uses the same precedence: explicit `--store <ref>` > nonempty
`AB_STORE` > `[store] url` > `<main-repo>/.autobuild`. Relative local overrides are normalized
against the main checkout. A local override relocates the whole state tree,
including `worktrees/` and default file tickets; an explicit `[tickets].dir`
remains repo-relative. An HTTP(S) URL still selects the remote store unchanged,
while worktrees and default file tickets remain under the repository-default
`.autobuild/` directory. The dispatcher passes its normalized selection to
every agent session as `AB_STORE`.

## Connect a project

From a checkout with an origin remote, run `ab connect https://YOUR_ORIGIN`.
The CLI prints a verification URL and short code and attempts to open a browser.
Sign in as an allowed owner, check the full repository identity and code, and
approve or deny. Another device can open the printed URL, or visit `/connect`
and enter the code. Approval requires the web-enabled service origin; a
standalone machine-only listener cannot present browser consent. Requests
expire after ten minutes. Denial and timeout leave local configuration unchanged.

On approval the service registers the project and issues a project credential.
The CLI keeps it in `$XDG_CONFIG_HOME/autobuild/credentials` (or
`~/.config/autobuild/credentials`), keyed by normalized service and origin,
with directory mode 0700 and file mode 0600. Credentials never belong in the
repository. It adds the non-secret `[store] url` to `autobuild.toml` when
absent; review and commit that change yourself. An existing different URL
must be changed explicitly before connecting. Reconnecting replaces the saved
credential only after approval and revokes the previous credential.

All worktrees share the main checkout's configuration and the user's saved
credential. A service manager running as that user uses the same HOME and
XDG_CONFIG_HOME, with no AB_STORE or AB_TOKEN exports. A fresh clone with
committed store configuration but no saved credential fails with `ab connect`
guidance; it never silently creates local state. Run connect on each host/user.

`ab connect` without a URL reports service, project, and credential status:
accepted, rejected, missing, or unreachable. `ab disconnect` revokes the saved
credential remotely before removing it locally, keeping the project registered,
its data, and store configuration. A network/server failure retains the local
entry for retry; an already revoked credential can be removed. If saving a new
connection fails, the CLI cancels/revokes it and retains the previous entry.
If remote cleanup cannot be confirmed, check the printed credential id with
the owner's administrative tools before retrying.

Store selection is `--store` > nonblank `AB_STORE` > `[store] url` > the
main checkout's `.autobuild/`. `AB_TOKEN` overrides the exact service/project's
saved credential for CI and other non-interactive hosts. A service override
never borrows another service's credential. Build and harvest sessions keep
their explicit scoped authority.

## Source-agnostic ticket operations

The sessionless `ab ticket` namespace constructs whichever TicketSource the
repository's `[tickets]` table selects. These forms therefore work unchanged
with Linear and the file tracker, without provider-specific API/MCP calls:

- `ab ticket create <title> --body <file> [--state <state>] [--labels a,b] [--blocked-by id,id] [--json]`
  files a ticket. Without `--state`, the source uses `[tickets].createState` or
  its own default. A named state is passed through unchanged and the selected
  source validates it before creating anything. Blocker ids belong to the same
  source and are also checked before the single create call.
- `ab ticket update <id> [--title <title>] [--body <file>] [--labels a,b] [--json]`
  partially replaces editable fields. At least one editable flag is required;
  `--json` alone is not an update.
- `ab ticket block <id> <blocker-id[,blocker-id...]> [--json]` adds one or more
  blocking relationships.
- `ab ticket unblock <id> <blocker-id[,blocker-id...]> [--json]` removes one or
  more blocking relationships.
- `ab ticket list [--state <state>] [--labels a,b] [--json]` lists tickets. With
  no filters it uses exactly dispatch's configured ready state and source-aware
  default labels. If either filter is present, only explicitly supplied
  criteria apply; every requested label must match.
- `ab ticket show <id> [--json]` reads one complete ticket. Human output includes
  labeled metadata and the body verbatim, so it can read a stored spec back.
- `ab ticket move <id> <state> [--json]` transitions one ticket and reports its
  post-transition value.
- `ab ticket states [--json]` lists every state of the configured source:
  lifecycle states first (triage, ready, doing, done), then custom states
  alphabetically. Each row has the state name, the roles it plays under the
  current config (create, ready, claimed, triage, proposal, done, or none), its
  ticket count, and its purpose when set. `--json` emits one bare array of
  `{name, roles, tickets, about?}`.
- `ab ticket state create <name> [--about <text>] [--json]` makes a state, for
  example `icebox`. It is idempotent: an existing state is reported as already
  existing, and `--about` (one line) records or replaces its purpose. A name is
  one to forty lowercase letters, digits, and hyphens starting with a letter,
  and may not match an existing state case-insensitively. There is no rename or
  delete. Only the file source supports `states` and `state create`; other
  sources exit nonzero naming the source and the unsupported operation.

State names and ids are source-local. For block and unblock, the first id is the
ticket being changed and the comma-separated second operand names its blockers.
Create validates every `--blocked-by` id before filing. The relationship forms
deduplicate their list and validate the target plus every blocker id before
writing any edge; block also rejects a direct self-block. An unknown id fails
the whole invocation without a partial write. Adding an existing relationship
and removing an absent relationship to an existing ticket both succeed as
no-ops, so either command is safe to retry.

Blockers gate a ticket when the dispatcher tries to claim it. Adding a blocker
to a ticket that has already been claimed into a build does not stop that build.
For dependent tickets, follow the
[safe blocker-filing workflow](references/ticket-dependencies.md): determine the
intended final destination, stage outside ready, verify all blocker relationships,
and move to ready last. Direct Linear creates the issue and its blockers
in separate requests; one `create --blocked-by` call is not atomic publication.
Harvest's creation reservations cover Harvest only, not interactive CLI creates.
Dependency order and JSON id extraction are still required, but do not alone
prevent an active dispatcher from claiming a partially created ready ticket.

Update is partial: omitted fields remain untouched, including labels, assignee,
and provider metadata. `--labels` is a complete replacement and an explicitly
empty value (`--labels ''`) clears the list. Supplied title/body values must be
nonblank. State is intentionally not an update field — `transition()` remains its sole owner —
and every validation or unknown-ticket error occurs before
mutation and names the offending field or id. `--body` always names a file; a
missing file fails before a source write.

Quote multiword Linear states, for example `"In Progress"`; file states are
case-insensitive on input and canonical on output. The adapters validate
transitions, so an invalid state fails with the
source's known states. A missing id fails nonzero with an error naming both the
id and configured source.

Human-readable output is the default and must not be parsed for ids. The CRUD
subcommands accept `--json`, which emits one bare JSON value and no prose: a
`Ticket[]` for `list`, and the complete resulting `Ticket` for `create`,
`update`, `block`, `unblock`, `show`, or `move`.

### Ticket assets

A ticket asset is a file or folder attached to a ticket: a design export,
reference screenshots, or a sample payload. Hosted tickets store assets in their
ticket service, independently of the build store; file tickets use native portable
assets composed with legacy BuildStore attachments. Sources without native assets
use the BuildStore. Existing service assets need no migration. Old local hosted-ticket
assets are not moved and are not a fallback. Each has a kind and a name.

- `ab ticket attach <id> <kind> <path> [--name <name>] [--json]` stores `<path>`
  (default name: its basename). Attaching the same kind and name again makes a
  new revision; earlier ones stay retrievable. Over the store's size limit
  (25 MiB by default, lower on a hosted deployment) it is refused. Attach and
  remove leave a note on the ticket naming the asset.
- `ab ticket show <id>` lists the current assets; with `--json` the ticket
  gains an `assets` array.
- `ab ticket asset get <id> <kind> <name> <dest> [--rev <n>]` downloads the
  exact bytes of the latest (or given) revision; `ab ticket asset rm <id> <kind>
  <name>` drops it from the current assets.
- **Frozen at claim.** A claim pins the current revisions into the build.
  Hosted revisions are copied into immutable snapshots in the build store,
  preserving revision numbers and allowing reads without the ticket service.
  Old pins without snapshots keep reading their original ticket rows. A
  later attach or remove leaves a running build alone; a human answer with
  `--revise-spec-from-ticket` pins again. `ab build asset get <slug> <kind>
  <name> <dest> [--rev <n>]` downloads what the build froze, also after it ends.
- **Where phases find them.** `ab context` writes each pinned asset to
  `$AB_CONTEXT_DIR/assets/<kind>/<name>/` (a file asset is the single file inside that
  directory) and lists them under `assets` in `$AB_CONTEXT_DIR/context.json` with kind,
  name, revision, layout, size, and path. The key is absent when the build has
  none.

By convention the `design` kind is a visual or reference contract, exported to
static files when the ticket is groomed, so no build converts a link. The spec
cites it by kind and name. See [the lifecycle](#the-lifecycle) for how phases
judge against it.

## Retrieving build artifacts

`ab artifact download <build> <kind>[@rev] --output <file> [--store <ref>]`
is the read-only binary retrieval form. Operators need no session identity: it
works after a build is terminal, writes exact bytes (creating parent
directories), verifies that the build belongs to this repository, and uses the
standard explicit `--store` > nonblank `AB_STORE` > `[store] url` > repository-local selection.
Inside a phase, a complete ambient tuple permits only the ambient build; a
foreign build or malformed/partial identity is rejected. Use the exact pinned
`@rev` from a PR attachment command.

Repository-scoped streams have their own form:
`ab artifact download stream:<id>[@rev] --output <file> [--store <ref>]`. A
stream id is store-assigned and globally unique, so no build argument is
needed; the command resolves the stream, requires it to be repository-scoped
and owned by this repository, and retrieves the artifact its close finalized
(§7.6) — an open stream has no artifact yet. This form is strictly an operator
read: under any complete ambient build or Harvest identity it fails closed
(§8.2), since repository-scoped targets are never reachable by ambient
own-build or own-harvest authority. Find stream ids in the session rows of
`ab harvest status`.

In a build session, `ab artifact put <kind> <file> --attach` atomically deposits
the exact bytes and designates that revision for the PR. A later designation of
the same kind replaces it; distinct kinds remain distinct attachments. The
ordinary form without `--attach` remains a private BuildStore deposit, and
in-session `put|get` still require ambient phase auth.

## Dispatch dashboard

Both dashboards also show the current authoritative dispatcher's unresolved
rollback: failed and restored runtime (version and commit), held failed runtime,
and rollback event timestamp. A matching durable different-target hold clearance
removes the notice. An operator restart hides the previous lineage's notice once
its new lineage commits an operational tick or accepted takeover. A run-started
fact or yielded tick alone cannot hide it; same-lineage generation changes retain
it. Historical rollbacks and other lineages' holds are never fallback notices.

Both dashboards show each accepted unfinished handoff: source and target runtime
version and abbreviated commit, mode, and drain deadline (unknown when unrecorded).
Outstanding predecessor executions in drain mode carry `(draining)` alongside
their lifecycle status. Matching durable settlement clears a build marker;
accepted completion clears its handoff banner. Takeover, an overdue deadline
and an empty outstanding set do not complete a handoff. Multiple unfinished
generations remain visible; cutover does not mark builds draining.

Integration list rows show parent commit distance (current or unknown when appropriate),
name the destination and show children merged out of the
known total, with the remainder split into building and queued. Cancelled
children are excluded. Missing or diagnostic-bearing observations show
`children unknown`; a successful empty enumeration shows `no children yet`.
The five list steps are `spec`, `open`, `collect`, `verify`, and `merge`, with
verification progress or failure and the merge mode in parentheses. Before
a policy decision, label-dependent modes may read `policy pending`. A current
verified node adds `verified`. Only restack conflicts, current verification
failures (file a repair child targeting the node), and readiness awaiting
consent add a list alert. Consent names `l` and `ab merge <slug>`. Branch,
restack state and conflicting files remain in detail, along with every child's
ticket id, title and live phase (or queued/merged), open-first counts, verification
steps and current outcomes, repair instructions, and the merge rule. Cancelled
children are omitted; historical missing titles or filenames are explicit.
The operator web app uses the same facts as text, without a graphical bar.

On a TTY, `ab dispatch` renders one fixed interactive frame anchored at the
terminal's first row. Its header remains on that top row as frame height changes
and after a resize; unused rows remain below. On exit, the final frame is copied
to the normal screen and remains in scrollback. Its always-present two-line
process-global header has a selectable `Autobuild` summary with the repository
basename followed by the compact counters
`queue <depth> | active <current>/<limit> | observations <current>/<limit>`.
`queue` is the ready-ticket queue depth; `active` is the current
nonterminal-build count against root `capacity`; and `observations` is the count
of recorded observation occurrences not yet claimed by a Harvest snapshot
against `policy.harvestThreshold`. The Store-only interactive frontend refreshes
that display value directly from the BuildStore; a failed refresh retains the
last successful count, shows a diagnostic, and appends no transport event.
Non-interactive dispatch performs no frontend-only sampling, and the separate
drift trigger is not displayed. An indented controls line follows for
`intake ON`/`intake OFF` and `harvest ON`/`harvest OFF`, plus a conditional yellow `repository PAUSED` segment while
the durable repository-wide hold is set. The controls start in the title
column. From the top of the frame through the body, the two-column marker lane
stays empty except for the selected row's `> ` marker. These controls and the
pause segment are durable repository projections and converge across
dispatchers on the existing poll; harvest specifically reflects its
acknowledged gate, not pending intent. Routine tick
counts, dependency diagnostics, parked-build notices, harvest outcomes, and
action confirmations are suppressed in the interactive frame. The latest true
warning or error instead appears on a conditional row below the header, aligned
to the title; when none exists, that row consumes no space. A blank line
separates the global section from the first body row, and another separates the
body from the legend or feedback controls. The duplicate startup banner is
suppressed; `--plain` and non-TTY output remain line-oriented and unchanged. A
satisfied verify skip carries the literal `skipped` qualifier, so it remains
distinct from a pass without color. Every nonterminal build has a row,
including `queued` builds that have not attached a runner. A queued row shows
its ticket, slug, literal `QUEUED` status, and either the pending dispatch
boundary or the latest durable `dispatch.failed` stage, attempt, and error.
While the repository hold is set, only queued rows gain a yellow `(held)`
modifier beside `QUEUED`; intake being off without that hold shows neither
`repository PAUSED` nor `(held)`.

A build row previews each unresolved blocker and setup error as at most three
rendered rows, preserving authored newlines and one blank row between
paragraphs. Longer messages add the withheld-row count and name `Enter details`;
that existing detail view shows the setup error and every blocker in full.
Up/Down scrolls detail content, Left/Right selects a session, and Enter opens the
selected transcript. Harvest failure detail and each process warning use the
same three-row cap and count but advertise no unavailable expansion action.
These are display-only transformations: stored event and status text is
unchanged.

When the selected session carries a stream, Enter instead opens a read-only
session view, whether that session is still open or has already ended. For an
open session the view follows the stream live: the turn's prompt, the agent's
reasoning and answer text, each tool call with a one-line input summary, tool
output capped at eight rows (longer output names the withheld-row count), and
step separators appear as they land, within one dashboard poll interval, while
the view tracks the tail. For an ended session the view renders the session's
finalized content, including error and truncation markers where the runner
emitted them, and a final `Stream closed` line names the outcome. Up/Down
scrolls; scrolling up from the bottom pauses tail-following — the legend says
`paused` — and scrolling back to the bottom resumes it. The view is strictly
read-only: no key inside it answers, pauses, resumes, or aborts anything, the
abort confirmation cannot be opened from it, and its legend offers only
Up/Down, Esc, and quit. Escape returns to build detail with the same session
selected. Sessions without a stream keep the existing messages: the
open-session unavailable note, the reclaimed note, the no-deposit note, and the
existing transcript rendering.

Up/Down moves without wrapping through global first, optional `Harvest` second,
then slug-sorted builds. Stable discriminated identity preserves selection
through repaint, re-sort, and row appearance/disappearance. The legend is
contextual: every row offers navigation and quit; global offers `h harvest`,
`i intake`, `p pause all`, and `r resume all`; `Harvest` offers `p resume`
for ordinary failure or `p acknowledge` for exhaustion/escalation only when
available. Selected builds offer `l merge` and `o hold`, subject to command
eligibility, plus the state-specific `p pause`, `p cancel pause`, or `r resume`
action; queued builds offer `d discard`. Merge requires readiness; hold may be
recorded before readiness. There is no repository merge toggle.

A running build reads `PAUSING` after `p` appends its pause request and before
the live session stops and the kernel records its suspension. Pause interrupts
live agent work immediately; resume continues where it stopped when supported,
while remote or unsupported sessions rerun fresh with a recorded fallback reason.
Without a live agent, acknowledgement still waits for a safe boundary. During
that window `p` appends
the opposing resume request, cancels the stale pause, and projects the build
back to `RUNNING`. An acknowledged paused build offers only `r resume` and reads
`RESUMING` until the kernel acknowledges that request; there is no gesture to
cancel a pending resume. Blocked takes visual precedence, including when the
build is also operator-paused, and `r` opens the existing feedback field. Keys
that are not offered for the current build state are no-ops and append no
control event.

Global-row `p` is the repository-wide version — the same walk `ab pause --all`
runs sessionless: it durably holds every `QUEUED` build, turns intake off, and
appends `build.pause-requested` to every `RUNNING` build, so the repository
comes to rest before a machine, terminal, or dispatcher restart. The hold is the `dispatcher.pause-set` repository fact, written before
the intake fact; while it is set no dispatcher tick attaches a runner to a
queued build, whether through interrupted-dispatch recovery, startup resume, or
the lease sweep. The per-build walk skips `PAUSING` — the bulk control never
cancels a pending pause, unlike build-row `p` — and skips `QUEUED`, `PAUSED`,
`RESUMING`, and `BLOCKED` without error; queued builds are covered by the hold
instead. Global-row `r` reverses all of it: the hold released,
`build.resume-requested` on every `PAUSED` build (including builds paused by
hand beforehand), and intake back on. A released queued build becomes
launchable again on the next ordinary tick, with no further operator action. `r`
does not touch `BLOCKED` builds, whose blockers still need the per-build `r`
feedback field. Both report the affected build count, the hold, and the new
intake value on the notice row. One carve-out remains: the harvest gate is
independent, so a harvest session can still start after a bulk pause (`h` stops
it). The janitor is likewise ungated, so an abort or discard on a held build is
still settled. Build work in this repository is otherwise genuinely at rest.

`--intake` and `--no-intake` are mutually exclusive durable repository setters.
Omitting both reuses stored state, falling back to ON only when no intake fact
exists. Global-row `i` re-reads current state and appends the opposite value.
Intake off skips only new ticket claims while janitor, stale-runner, harvest,
and in-flight work continue — it deliberately does **not** set the repository
hold, so a build the repository has already accepted still starts and finishes.
Every dispatcher samples the current value on each tick, so a change in one
process gates all dispatchers for that repository.

The repository hold has no launch flag and no setter of its own: `p` and `r` on
the dashboard's global row and the `ab pause --all` / `ab resume --all` walk
they share are the only ways to set or clear it, and each of those moves intake
with it. Each dispatcher frame reads the hold from the repository journal
itself, so an already-paused repository shows `repository PAUSED` and `(held)`
on its first paint; clearing the hold removes both on the next poll. The hold
survives a restart and is not defeated by re-running `ab dispatch`.

`[[merge]]` rules in `autobuild.toml` determine merge policy. The
dispatcher records an immutable decision when each candidate becomes ready.
No rules means leaf auto / node consent. There is no claim-time default
seeding or fan-out over existing builds. `ab merge <slug>` supplies consent to
that merge and frozen destination; it survives replacement heads until hold
or completion. `ab hold <slug>` suppresses policy and withdraws consent.
The old `--auto-merge` / `--no-auto-merge` flags and `ab auto-merge` command
are retired and return actionable errors; use merge rules and hold/merge.

Global-row `h` re-reads the repository journal and appends the existing human
pause/resume request. The newest pending command determines the next target, so
rapid presses issue opposing requests; the token changes only after the kernel's
`harvest.paused`/`harvest.resumed` acknowledgement.

`Harvest` uses the same marker, right-aligned status column, and status colors
as builds; its internal run id is not shown. One row selects the oldest
unresolved ordinary failure, exhaustion, or escalation attention before the
oldest open run, so later running/completed work cannot hide it. Completed runs,
an idle paused repository, acknowledged recovery exhaustion, and dismissed
escalation have no row. A paused open run freezes and reads `PAUSED`. Ordinary
failure reads red `FAILED`, marks the stopped step, shows automatic progress,
and offers `p resume`. Exhaustion remains red, says `recovery exhausted — human
attention required`, shows stopped step/pending count, and offers `p
acknowledge`; escalation also offers `p acknowledge`. A request awaiting
acknowledgement has no duplicate action. Row `p` never pauses the gate. When the
gate is off it writes nothing and directs the operator to global `h`; the
eventual shared human acknowledgement reopens every ordinary parked run and
settles every exhaustion barrier. Exhaustion and escalation remain terminal.
Escalation's row is dismissed only by a post-terminal human resume request
followed by its later kernel acknowledgement, never by the request alone.

Every build row renders a `merge <state>` token. Cyan requested means
authorized but not yet applied natively; green enabled means the native request
is armed; yellow cancelling means cancellation is in flight; dim off means no
authorization. A recorded consent decision waiting for an operator reads
`merge awaiting consent`; an explicit hold reads `merge held`.
There is no red comparison with a repository default. Row and detail merge
explanations distinguish a pending policy decision, consent, and hold, and name
`ab merge <slug>` / `ab hold <slug>` where appropriate.
Merge conflicts recover automatically: the gate defers, the pipeline re-enters
reconcile, and verify re-runs before consent is re-examined — the reconcile
step on the build row is the only indication, and uncomputed mergeability
resolves the same way on a later poll. The auto-merge gate records a durable
observation only for a deferral a person must fix (disabled repository
auto-merge, a dirty local checkout, a missing Git identity, an unproven gate
state, a plan limitation) — never for a conflict the pipeline resolves itself.
A recorded deferral stops being shown once the PR merges or closes, or once a
reconcile or re-finalize supersedes it, until the gate re-examines consent.

### Durable build controls: CLI and dashboard

The CLI and dashboard are two surfaces over the same store-backed control
operations. Use the CLI from a non-TTY, a script, or an assistant; use the
keys while watching the interactive dashboard. Both append human-authored facts
to the build's event log and apply the same write-time checks.

| Intent | CLI | Dashboard | Durable event(s) |
|---|---|---|---|
| Discard interrupted dispatch | — | Select a queued build and press `d`. | `build.discard-requested` |
| Pause | `ab pause <slug> [--store <ref>]` | Select a `RUNNING` build and press `p`; press `p` again while `PAUSING` to cancel the pending pause. | `build.pause-requested`; cancellation reuses `build.resume-requested` |
| Resume | `ab resume <slug> [--store <ref>]` | Select a `PAUSED` build and press `r`. | `build.resume-requested` |
| Pause all | `ab pause --all [--store <ref>] [--json]` | Select the global row and press `p`. | `dispatcher.pause-set` (first), `dispatcher.intake-set`, then one `build.pause-requested` per `RUNNING` build |
| Resume all | `ab resume --all [--store <ref>] [--json]` | Select the global row and press `r`. | `dispatcher.pause-set` (first), `dispatcher.intake-set`, then one `build.resume-requested` per `PAUSED` build |
| Consent to merge | `ab merge <slug> [--store <ref>]` | Select a ready build and press `l`. | `build.land-requested`, then `landing.command-acknowledged` |
| Restack node | `ab restack <node> [--store <ref>]` | CLI/tool request; normal safety gates apply. | `node.restack-requested`, then `node.restack-satisfied` |
| Hold merge | `ab hold <slug> [--store <ref>]` | Select a build and press `o`, including before readiness. | `build.hold-requested`, then `landing.command-acknowledged` after native cancellation |
| Answer blockers with guidance | `ab answer <slug> <text> [--store <ref>]` | Select a blocked build, press `r`, enter text, then Enter. | One `escalation.answered` with `resolution: guidance` per applicable blocker. |
| Retry blockers without guidance | `ab answer <slug> [--store <ref>]` | Open the same `r` field and press Enter empty or whitespace-only. | One `escalation.answered` with `resolution: retry` per applicable blocker. |
| Dismiss cited finding chains | `ab answer <slug> --dismiss [--store <ref>]` | CLI only; build detail names the command. | One `escalation.answered` with `resolution: dismiss-finding` per blocker that cites a real review finding. |
| Revise spec from a file | `ab answer <slug> --revise-spec <file> [--store <ref>]` | CLI only; build detail names the command. | For leaves, human `escalation.answered` then kernel `spec.revised`; eligible nodes publish `spec.revised` with operator provenance. |
| Re-import revised ticket spec | `ab answer <slug> --revise-spec-from-ticket [--store <ref>]` | CLI only; build detail names the command. | The same leaf answer or direct node `spec.revised` protocol. |
| Abort | `ab abort <slug> [--store <ref>]` | Select any non-terminal build and press `a`, then Enter to confirm (Escape cancels). | `build.abort-requested` |

The two `--all` forms and the global-row keys are one walk behind two surfaces.
The repository pause is written first and intake second, both absolutely —
setters, not toggles, so the values the command names are the values the
repository holds afterwards — and each per-build request is a compare-and-set
against a freshly reduced log, so a rerun adds no second pending pause and
never cancels one already in flight. Pause first is what makes every surviving
prefix of a failed walk at least as quiesced as asked: once it merges, no queued
build is launchable, whatever else fails after it. Output names every build that
received a request, the hold, and the intake value written; `--json` emits that
same summary for a script. A walk that fails partway exits nonzero and reports
which of the two repository facts landed, which builds were requested, which one
failed, and which were never attempted. Neither form starts a dispatcher, so
reaching for one to quiesce the repository does not launch the work it is trying
to park.

Discard is dashboard-only and queued-only. After any launching execution has
released its process-tree lease, the dispatcher releases a partial workspace,
returns the ticket to `[tickets].readyState`, and completes the old build as
`discarded`; a later tick may claim the ticket into a fresh build. This is not
abort: abort returns the ticket to Triage.

Abort accepts queued, running, paused, or blocked builds. A live turn receives a
cancellation signal and the runner acknowledges the request. Its execution
supervisor signals the local runner leader and waits for it to finish persistence
and exit, then reaps remaining descendants with bounded TERM-then-KILL cleanup.
Only then does it release the lease. Graceful dispatcher shutdown likewise waits
for runner suspension without a wall-clock force-exit deadline.
The dispatcher defers cleanup while that lease is live, then performs the
checkpointed, retry-safe cleanup: close an open unmerged PR, release the workspace,
delete the exact remote and local build branches, preserve existing ticket labels
while adding `autobuild:aborted`, return the ticket to configured Triage, and post
an abort notice before
completing as `abandoned`. Missing
Forge cleanup capabilities or provider outages leave cleanup pending with an
actionable diagnostic for the next tick.

On the dashboard, `r` on a blocked build replaces the bottom legend with a
multi-line composer panel: the build being resumed, a note that guidance is
optional, the build's unresolved blocker questions, the field itself, and its
key bindings. All printable keys edit the field instead of triggering dashboard
actions. `Enter` submits (an empty field resumes without guidance), `Ctrl-J`
inserts a line break — as does `Shift+Enter` in terminals that report it
distinctly — `Backspace` deletes at the caret, `Left`/`Right`/`Up`/`Down` and
`Home`/`End` move the caret rather than the dashboard's row selection, and
`Escape` cancels without writing. Line breaks survive submission, so the
guidance the agent receives keeps the operator's line structure. Pasting
multi-line text inserts all of it in one step in terminals that support
bracketed paste; where they do not, a paste still submits at its first line
break.

`ab answer` answers every escalation that is open when the command runs,
regardless of `agent`, `stall`, or `policy` source. Its text is joined, trimmed,
and delivered as authoritative guidance. With no text (or only whitespace), it
requests a bare retry and supplies no agent guidance. Verify has two explicit
answer routes: guidance answering an agent verifier's own `ab escalate` returns
to that same `verify:<step>` on `verify.started.feedback` and materializes as
`$AB_CONTEXT_DIR/guidance.json`; the cited start carries it durably across any pre-launch
recovery, and the matching `session.started` consumes it once after launch.
Guidance answering the policy escalation after exhausted failed verify reports
instead goes to `implement` and outranks the pending report. A bare retry on either path carries
no guidance. The dashboard captures the blocker ids when its field opens, then
answers only those still open at submission; Escape cancels without writing. If
the build is also paused, both surfaces append all answers first and
`build.resume-requested` last. A plain
`ab resume` does not answer blockers; use `ab answer` for a blocked build.

An answer is not only recorded — it is delivered to the agent that can act on
it. An escalation from `plan` or `plan-review` feeds the next `plan` round.
An escalation from `implement` or `code-review` feeds the next `implement`
round. An agent verifier's own escalation feeds the next run of that same
`verify:<step>`. When a failed verify report exhausts policy, guidance answering
that policy escalation instead feeds the next `implement` round and takes
precedence over the failed report. When several answers are waiting for one
engine-routed destination (`plan`, `code`, or the same exact verifier), only the
newest is eligible: it durably supersedes older answers, which do not resurface
after the winner is delivered. Destinations remain independent, and a new
answer recorded after an earlier delivery is eligible for the next appropriate
run. `finalize` and `reconcile` receive their own answers on their next attempt.
In each of these routed cases, `ab context`
writes the answer to `$AB_CONTEXT_DIR/guidance.json` in the build's workspace, and the
receiving skill treats it as authoritative feedback for that round or attempt.
A producer round has one immediate feedback kind: on a guidance round,
`$AB_CONTEXT_DIR/guidance.json` takes precedence over findings or the legacy
single-report feedback. A referenced `verifyStageFailure` receipt remains
available alongside guidance, with every failed report and cancelled/not-run
member; it is not erased by feedback precedence. A bare retry writes no
`$AB_CONTEXT_DIR/guidance.json` and displaces nothing: the resumed round still gets whatever
the loop was already routing, such as the last review round's findings.

`--dismiss` is per escalation. It answers only blockers that cite at least one
real plan-review or code-review finding; blockers with no such citation remain
open. A dismissed finding id means a human retired that disagreement. The next
reviewer receives `$AB_CONTEXT_DIR/dismissed-findings.json`, must not re-raise the finding,
and must use a fresh id without `persists` if a genuinely different problem
touches the same code. Dismissal settles a chain, not a file or the reviewer's
ability to report new problems.

Leaf spec revision requires an open escalation. `--revise-spec` reads a conforming
replacement from a file; `--revise-spec-from-ticket` re-imports the build's
recorded ticket after an operator amends it. The human `escalation.answered`
fact names the exact deposited revision it authorizes, then kernel
`spec.revised` publishes it. If interrupted between those facts, a retry
completes the recorded body and does not use a newly supplied one. A
non-conforming body records nothing. The leaf restarts from `plan` on the new
revision and keeps any open PR. A build's spec can therefore change under it:
phase runs after the revision read the new revision, while historical runs
remain readable at the revision they actually saw.

Operators may explicitly revise an opened idle collecting node or a node blocked on failed
integration verification without an escalation. Use
`ab answer <node> --revise-spec replacement.md` or, after amending its ticket,
`ab answer <node> --revise-spec-from-ticket`. Ticket edits alone do not revise
the build. Both forms enforce the same spec standard as leaf revisions.
Each kernel `spec.revised` records the exact artifact and operator identity
(with optional transport provenance); earlier revisions remain readable.
Ticket-origin revisions re-pin assets; supplied bodies preserve asset pins.
The node recollects and verifies the new revision, including on the same head
and parent after a failed cycle. Earlier cycles remain historical evidence
and cannot block or authorize merge under the replacement. Children keep
their specs, claims and targets; contributions are not restarted.
Active verification/reconcile or writer work, restack/reparent work, pause,
pending controls, merge intent and ended PRs refuse the no-escalation path.
A concurrent state change refuses publication with a retry explanation;
uncited artifacts are inert. Leaves still require an open escalation and
restart from `plan`.

Every command requires an applicable target in this repository. Pause and
resume require an active build; abort and hold also accept queued builds.
Merge requires a ready candidate and cannot bypass verification or merge gates;
`ab answer` requires an open escalation except for eligible node spec revisions. A stale, missing, done,
aborted, or otherwise inapplicable target is an error and gets no new event. Attribution uses `USER`, then `USERNAME`, then the
same stable fallback on both surfaces. These commands run sessionless and
accept `--store <ref>` with the usual explicit flag > `AB_STORE` > `[store] url` > repository
local precedence. If nonblank `AB_SESSION` and matching `AB_BUILD` identify the
caller's own phase build, the command refuses it; a phase cannot pause, resume,
hold, merge, answer, or abort itself. `ab pause --all` and `ab resume --all`
accept `--store` on the same precedence and are refused for the same reason
whenever `AB_SESSION` and `AB_BUILD` are both nonblank — the caller's own build
is inside the walk.

These commands request normal kernel work; they do not wake a runner, operate
the forge, or bypass the lease sweep. Resume is therefore an attempt, not a
guarantee: if the condition still fails, a phase may raise a new escalation and
block again. Every open escalation, including all policy and setup causes,
survives `ab dispatch` and `ab dispatch --once` startup until a human answers
it. Startup still recovers actionable builds and delivers pending operator
commands, but it never records an answer or re-arms a budget.

Durable repository intake has launch-flag setters and a global-row toggle.
Merge policy is configured through ordered rules, with per-merge hold/merge
commands; no writable repository auto-merge default remains.
Abort is available through both its CLI command and the confirmed build-row/detail
`a` key. Global-row `h` owns the durable harvest gate. Global-row `p`/`r` and
`ab pause --all` / `ab resume --all` are two surfaces over the one walk described
above: from the same repository state they write the same events. Neither the
repository hold nor intake has a standalone sessionless setter of its own, but
the bulk commands write both as part of quiescing — the hold first. On the
optional repository-scoped
`Harvest` run row, `p` only resumes or acknowledges the represented run; `i`
and `h` are no-ops; `l` and `o` apply only to selected builds. On build
rows, `i` and `h` are also no-ops.

## Checking build status

The read-only status commands answer "what is happening?" without inspecting
SQLite, worktrees, or OS processes. Operators need no phase-session `AB_*`
identity; those invocations remain repository-wide. Inside a phase, a complete
ambient tuple permits `ab build status` only for the ambient build and denies
`ab builds` because it requires repository-wide collection access. Any partial,
malformed, shared-only, or mixed build/Harvest identity is rejected rather than
falling back to operator access. The commands append no events, take no leases,
and are safe to run at any time.

**`ab repository status [--json] [--store <ref>]`** reports ticket intake
(`intake`, default `true`) and repository-wide pause (`paused`, default
`false`), alongside dispatcher and infrastructure status. Its historical
`defaultAutoMerge` field remains an inert compatibility value; it is not
claim-time policy or a writable setting. Merge decisions and command state
are queried on the build. A repository with no journal row uses the defaults
without creating a row. Human output is the default. `--json` emits one bare
object including the canonical `repo`, and `--store` follows the usual explicit
flag > `AB_STORE` > `[store] url` >
repository-local precedence. The command uses the same reducer as the
dispatcher and dashboard, writes no state, claims no ticket, attaches no runner,
and starts no dispatcher work. Dispatcher identity includes the held run’s recorded
runtime; historical starts without metadata display `runtime unrecorded`.

**`ab builds`** summarizes this repository's builds, one row each. It reports
**active** builds by default — `running`, `paused`, `blocked` — because those
are the ones something can still be done about. `HEARTBEAT` is mutable runner
liveness; `PROGRESS` is the age of the latest durable event. A literal
`diverged` suffix means a nonterminal build still holds a live lease but its
heartbeat is at least one hour newer than its latest event. It is a visibility
signal, not a stalled/dead verdict.

| Flag | Effect |
|---|---|
| `--queued` | Also include `queued` builds — dispatched but not yet attached to a runner. |
| `--all` | Every status, including `queued`, `done`, and `aborted`. Subsumes `--queued`. |
| `--json` | The projection as JSON: no ANSI, no prose. Use this when scripting or parsing. |
| `--store <ref>` | Read a different store — a path or an `http(s)` URL, same reference behavior `ab dispatch` takes. |

An empty result names the filter in effect, so "no active builds" means the
filter matched nothing, not that the command failed. Widen it with `--queued`
or `--all` before concluding a build doesn't exist.

**`ab build status <slug>`** details one build: unresolved escalations, open
sessions, chronological durable observations, verify progress for the current
cycle, PR lifecycle, latest event, durable progress age, heartbeat, and lease.
Every runner attach appears chronologically with its recorded runtime (version,
commit, source kind/location), or `runtime unrecorded` for historical attaches;
JSON exposes nullable runtime in `runnerAttaches`. Phases belong to the preceding
attach boundary.
For an open PR, the current work-owner decision reads the build-owned
configuration from the store's deposited `build-runner-effective-config`
artifact — deposited at every runner launch and refreshed on effective-config
changes — falling back to the local workspace's `autobuild.toml` only when no
deposit exists; the decision is reported unavailable only when neither source
can supply a configuration, and that message names the missing artifact kind
rather than a workspace path.
Observations are shown without `--events`; for `forge = "local-git"`, this is where a deferred merge
names uncommitted work that collides with the squash. Autobuild leaves that work
untouched and later dispatcher ticks retry automatically after the operator
resolves it. `--events <n>` appends the newest `n` event envelopes in
chronological order — the fastest way to see what a build actually just did.

Verify progress covers the **current cycle** — the results since the latest
code-review approve or reconcile. Implement and reconcile change the code, so a
new cycle re-runs from the first stage and earlier results describe code that no
longer exists. An empty step list next to `attempt 1` therefore means the cycle
restarted, not that verify never ran. A skip renders as `SKIP` with its reason;
JSON exposes `outcome: "skipped"` and `reason`, never a synthetic pass.
Concurrent stages name every running verifier. Cancelled steps are shown as not
run with their fail-fast cause; `ab wait --for phase=verify:<step>` matches any
running member. Superseded escalation history remains available without an
answer-required or blocked effect.
`--json` and `--store <ref>` work the same here.

Use `ab builds` to find the build; use `ab build status` to understand it.

The open-session list is literal durable state. A graceful dispatcher stop
suspends local git-worktree agent turns, retaining their partial transcripts
and native handles. On restart, a matching host/path/runtime resumes the same
phase and round with fresh session credentials. The first message names the
interruption and asks the agent to re-check the worktree and re-run anything
in flight. Native state is an optimization; the Store remains authoritative.

`session.started.continuation` records resume intent before launch. Native
acceptance is a separate `session.resumed` fact; terminals may land before it.
Recovery retries an unaccepted attempt using its inherited handle. Suspended
sessions reject old credentials permanently. `session.resume-fallback` records
why native continuation could not be used (including remote workspaces), then
ordinary fresh-session recovery applies. Unrelated open sessions are reclaimed
without inventing transcripts. Dashboard history shows suspended and resumed
segments separately, with their individual transcript refs and usage.

The build phase budget counts active time across interruptions using the original
ceiling. Suspended intervals do not consume it; abrupt loss is conservatively
charged through recovery. Build pause immediately suspends a live turn with cause
`pause`, including remote sessions and sessions without a native handle. Resume
continues the local native session where eligible; otherwise the recorded
fallback explains the fresh rerun. Pause acknowledgement follows turn stop and
suspension or terminal settlement.

Each session row also shows its live-view stream: the stream id and
whether that stream is `open` or `closed` — for example `stream st_1f2e (open)`.
A session that never streamed (a plugin runtime without the streaming
capability, or a historical log) shows no stream segment. While a session
runs, its stream is the live view of the turn; once the session ends the
stream finalizes into an artifact, and `ab artifact download <slug>
stream:<id>` retrieves the closed session's finalized document.

Harvest sessions stream the same protocol into *repository-scoped* streams:
the harvest runner's synthesize and review brackets each get one stream
(`phase` spelled `harvest:<step>`), with `harvest.session.started` carrying
the stream id. `ab harvest status` shows each run's sessions the way build
status does — one row per session with its stream id and open/closed status
(`session hs_… (harvest, synthesize@1, open) stream st_… (open)`).
Suspended turns show `suspended`, a closed stream and partial transcript evidence.
The next dispatcher automatically continues them; the harvest gate remains independent. Once a stream
closes, its finalized document is a repository-scoped `stream:<id>` artifact,
and `ab artifact download stream:<id>` retrieves it; the stream form is an
operator-only read (ambient phase identity fails closed).

**`ab watch [<slug>...] [--repository] [--operator] [--event <glob>]... [--since <cursor>]
[--timeout <dur>] [--interval <dur>] [--count <n>] [--json] [--store <ref>]`**
streams matching events as they land instead of answering once. With no slug it
follows every nonterminal build in the repository — a build created while the
watch runs joins it without a restart — and naming one or more slugs watches
exactly those builds, ending the watch when all of them reach a terminal status.
With no slugs the repository journal is included; named watches add it with
`--repository`.

The default watch reports actionable conditions only:

- `integration.verification-failed`: failed node verification, once per prepared cycle, with failed steps, verified head and parent, and guidance to file a repair child targeting the node. Recovery reports only the latest prepared cycle while its head and parent remain current; superseded failures are not backfilled.

- `build.janitor-failing`: a build has failed janitor attempts for the configured attention threshold. A successful attempt clears it.
- `dispatcher.forge-persistent`: forge degradation remains after a post-reset retry tick; recovery clears the episode.

- Build `escalation.raised` or `phase.deferral-escalated`: an operator answer
  is required. A read deferral asks for CLI/store repair before retry or guidance.
- Build `build.merge-decision`: a finalized open PR
  with a recorded consent decision awaiting consent, an explicit hold, or a
  current actionable merge-gate deferral. Policy decisions not yet recorded and
  authorized merges awaiting application are silent. One merge decision is reported per build/PR.
- Repository `harvest.escalated`, `harvest.recovery-exhausted`,
  `dispatcher.config-rejected`, `dispatcher.config-reloaded` with nonempty
  `restartRequired`, `dispatcher.upgrade-failed`, `dispatcher.runtime-rolled-back`, abnormal `dispatcher.run-stopped`, and `dispatcher.lost`.
- `dispatcher.ticket-source-persistent`: degradation past its advertised
  reset time, once a tick started at or after reset has completed or failed
  with the episode still open; crossing reset alone is silent. Without a reset,
  the deadline is 15 minutes after onset. Repeated evidence never postpones
  the deadline; recovery ends the episode.
- `dispatcher.tick-failure-persistent`: continuously failing completed ticks
  for five minutes in one run. A successful tick, new run, or matching stop
  ends the episode. Source grace and cooldown-driven failures do not start
  this clock; after grace, the first qualifying failure starts a new five-minute
  interval. Each persistence episode is reported once. Repository read failures
  fail the watch tick and retry on the next tick; repeated failures use this
  existing attention. Validation errors include reducer, scope, cursor, field
  path, and running version/commit in the stored tick error.

Repository conditions are included with no slugs or with `--repository`.
Routine outcomes and self-healing failures are silent. Repeatable
`--event <glob>` replaces the default and selects exactly matching catalog
events (plus the existing `dispatcher.lost` observation); use explicit globs
to opt into failures, finalize, merge, or completion events.

Derived records use `observation` instead of `event`, without inventing a
durable sequence or actor. Merge observations carry `type`, `pr`, `reason`,
and `observedAt`, plus the build slug and normal reduced state. Persistence
observations carry source/cause/message/resetAt when advertised (or
run/firstFailure/error), `episodeSeq`, and `observedAt`; repository records
have `repo` and null build/state. Source observations also report
`dependencyLimited`.

Every record carries a cursor, including timer-only records. Resuming suppresses
delivered merge decisions and persistence episodes even when stream positions
did not advance. Old v1 cursors remain valid: historical eligible merge
decisions are treated as consumed; active overdue repository episodes may
report because old watches had no persistence notification. Fresh attachment
silently baselines historical direct events and merge decisions, but retains
active repository timers. Reconcile existing conditions through status after
arming the watch. Named watches still end when every named build is terminal;
learn their outcomes from status reconciliation at exit.

With `--json`, stdout is newline-delimited JSON — exactly one object per
matching event, flushed as soon as it is written — with fields `build` (slug,
or null for a repository event), `repo` (present only for repository events),
`event` (the complete durable envelope: build, seq, ts, actor, type, payload),
`state` (for build events, the reduction after that event: `status`, `phase`,
`round`, `openEscalations` with their ids and questions, `pr`, `prState`,
`outcome`; null for repository events), and `cursor`. Without `--json` each
record is one plain human-readable line. On every exit the last `--json` line
is a bare `{"cursor": …}` object reflecting the final position even when no
record matched. Cursors are opaque; resume with `--since <cursor>` and every
matching event after that cursor is delivered exactly once, in per-stream
sequence order — including events that landed while no watch was running. A
cursor from a different repository or store is rejected.


Dispatcher liveness is also visible through `ab repository status --json`:
`dispatcher.holder` identifies the unexpired repository lease owner, independently
of `latestRun`. Each run includes its recorded `runtime` (version, commit, and
source kind/location), or null for unrecorded historical starts. Heartbeat age measures attributable renewals; tick age measures
actual tick completion. Successful unchanged ticks leave no journal pair; bounded,
lease-fenced repository telemetry still records each actual completion and its
outcome. Last-tick age refreshes independently of the event cursor and never uses
heartbeat as completion evidence. Open telemetry protects unsafe work during
shutdown; historical journals retain their boundary fallback. Missing historical
evidence is null. The liveness query uses
bounded repository facts first, with a full-history fallback when a later
invocation hides the holder start or the latest stop. Other state reads retain
their bounded semantics.

Repository-following `ab watch` additionally emits a read-only `dispatcher.lost`
observation when an observed lease expires without a matching stop or validated
successor takeover. A completed ownership transfer suppresses predecessor loss
even while its sessions drain; a handoff without takeover still reports loss on
expiry. Successor loss and upgrade-failure/rollback attention remain independent. JSON carries
`observation` instead of `event`, with run, observedAt, leaseExpiresAt and available
identity, plus the usual repo/build/state/cursor fields. It invents no durable
sequence or actor. Retain the cursor to avoid repeat reports across invocations.
No lease alone is not evidence of death. SIGINT, SIGHUP and SIGTERM drain dispatch,
record the first signal in the stop fact, and release its lease before exit.

The watch ends with exit 0 when `--timeout` elapses (30 minutes by default;
`0` unbounded), after `--count <n>` records, or when named builds have all
gone terminal; with no slugs named, an empty set of active builds does not end
it. Usage errors, scope violations, unknown slugs, and cursor rejection exit 1
before any record. A store read that fails after the watch has started is
reported on stderr once per failing read source — locally the poll cycle is
one source, while against an `http(s)` store each tracked stream and the
discovery pass carries its own failure streak — and retried without
duplicating or skipping any event.
Against a local store the default cadence polls every 1 second. Against an
`http(s)` store each tracked stream long-polls instead — one held request per
stream waits up to 25 seconds for the next event, requests run concurrently,
and an appended matching event is delivered within about a second of its
append rather than at the next tick — while `--interval` (default 5 seconds)
still bounds the spacing between a stream's request starts, so a quiet stream
costs roughly one request per 25 seconds and a chatty one no more than one
request per interval. Without `--operator`, the command is read-only. Neither form appends an event,
takes a lease or starts work. Only flagged watches write advisory liveness, and deciding
what to do about a blocker or a merge stays with the caller, not the command.
Inside a phase, only the ambient build may be watched.

For a standing operator loop, first check `ab repository status --json` for
live `operator.registrations`. Report another live operator rather than registering
unless the human directs otherwise. Arm `ab watch --operator --json` with no slugs;
re-arm with `ab watch --operator --json --since <watch-cursor>` using only that
standing watch's own final or record cursor. Reconcile active and newly dispatched
builds after arming and on timeout. Keep watching after initially queued work ends.
`ab wait` neither renews presence nor carries registration identity. Separate
unflagged diagnostic watches and waits must not replace the monitor or its cursor.

`--operator` is advisory and permits multiple registrations. It rejects named
slugs, even with `--repository`, and any ambient build or scoped session. Heartbeats
run every 30 seconds independently of polling; orderly exits renew once more.
Presence expires five minutes after the last successful heartbeat, without any
unregister on exit. Reusing its flagged watch cursor preserves the registration
ID and original start time across re-arms. Unflagged resumes remain read-only.
Repository status lists live registrations with ID, host, PID, start, heartbeat
and heartbeat age, or an empty list. Human status prints one operator summary.
MCP registration and dashboard presence are deferred.

**`ab wait [<slug>...] (--for <condition> | --event <glob>)... [--since <cursor>]
[--timeout <dur>] [--interval <dur>] [--json] [--store <ref>]`** is the blocking
sibling of `ab watch`: it blocks until a targeted build satisfies a condition,
prints exactly one record, and exits with a code that tells the caller what
happened. Target selection matches `ab watch` — no slug targets every
nonterminal build (builds created while waiting join; an empty or entirely
terminal set keeps waiting for a build to appear), named slugs target exactly
those builds, and an unknown slug is an error before waiting begins. Inside a
phase, only the ambient build may be waited on.

At least one `--for <condition>` or `--event <glob>` is required. The condition
vocabulary is closed: `blocked`, `paused`, `running`, `collecting`, `done`, `aborted`,
`terminal` (done or aborted), `pr=open`, `pr=merged`, `pr=closed`,
`pr=conflicted`, `phase=<phase>` (a core phase — `plan`, `plan-review`,
`implement`, `code-review`, `finalize`, `reconcile` — or `verify:<step>`), and
`attention` (current failed node verification, an open escalation, janitor failure attention, or a build waiting for a merge decision). Repeatable `--event`
globs follow the `ab watch` rules. Multiple values are alternatives: the first
one satisfied ends the wait — all `--for` values in supply order, then all
globs in supply order — and the record names what matched.

A status, PR, or phase condition is satisfied when a targeted build's reduction
has that state — the same projections `ab build status` reports, so `blocked`
means an open escalation exactly as everywhere else. In the manner of `kubectl
wait`, a condition that already holds when the command starts returns
immediately with that build's latest event (`--since` does not suppress this);
otherwise the first later event whose reduction produces it ends the wait.
`attention` is also a current-state condition: current failed node verification, existing janitor failure attention, an already open escalation or
merge decision returns immediately, including with `--since`. Merge matches
use the same observation as watch. During replay, only new failed-node verification or escalation events
or undelivered eligible merge decisions satisfy attention. `--event` conditions
fire only on new events or a cursor-resumed backlog.

Default `ab watch` and `ab wait --for attention` also deliver
`phase.deferral-escalated`, preserving its original event type, id and sequence.
Its question asks for CLI/store repair and an explicit retry or guidance answer.
Explicit event globs continue to replace the default filter.

The record is the `ab watch` record plus a `condition` field naming the
satisfied `--for` value or `--event` glob. Unlike `ab watch`, there is no
trailing cursor object: the record's own `cursor` is the final position.

Exit codes: 0 — satisfied, exactly one record printed; 1 — usage errors, scope
violations, unknown slugs, or a store that cannot be opened at start; 2 —
slugs were named and every named build went terminal without satisfying any
condition (one record with `condition` null, showing how the build ended); 3 —
`--timeout` elapsed (30 minutes by default; `0` unbounded; with `--json`,
stdout is a bare `{"cursor": …}` object for the final position, plus one line
on stderr); 4 — interrupted by SIGINT before any condition was satisfied (same
cursor behavior as 3). The default poll interval and `--interval` match
`ab watch`. A store read that fails while waiting is reported on stderr once
per failing read source — locally the poll cycle is one source, while
against an `http(s)` store each tracked build and the discovery pass carries
its own failure streak — and retried without missing or duplicating a
condition. The command is
read-only — it appends no event, takes no lease, and creates no record — and
deciding what to do about a match stays with the caller's skill.

Two recipes cover the common harnesses. First, a single-wake-up harness
(Claude Code's background Bash mode re-invokes the agent exactly once, when the
command exits): run `ab wait` as a background command and let the exit code
plus the one record be the whole wake-up payload —

```sh
ab wait --for blocked --json my-build   # exit 0: record says why; 2: it ended; 3: re-arm
```

Second, a plain blocking call — Codex, Pi, and the shell only expose "run a
command and wait": run it in the turn and read the record when it returns.

The loop pattern ties the two together: wait, act on the record (answer the
escalation, inspect the build, merge the PR), then wait again, passing the
record's `cursor` back through `--since` so no event is ever examined twice:

```sh
last=$(cat .ab-wait.cursor 2>/dev/null || true)
record=$(ab wait --for attention --json --timeout 30m ${last:+--since "$last"} my-build)
code=$?
cursor=$(printf '%s' "$record" | grep -o '"cursor":"[^"]*"' | cut -d'"' -f4)
[ -n "$cursor" ] && printf '%s' "$cursor" > .ab-wait.cursor
# exit 0: $record names the condition in its `condition` field — act on it.
# exit 2: the build ended without the condition; exit 3: deadline, re-arm.
```

**`ab harvest status [--events N] [--json] [--store <ref>]`** projects the
**`ab harvest status [--events N] [--json] [--store <ref>]`** projects the
durable repository gate and an ordered collection of every unresolved failed
run plus relevant open/latest context from the same journal the runner resumes.
Each section distinguishes recoverable from terminal and shows that run's
automatic attempts/limit, stopped step/round, attention, exact retained snapshot
before exhaustion or released observation/proposal keys afterward, workflow
occurrences, review rounds, and filed ticket refs. A durably suspended local turn
shows `suspended` in status and both dashboards, with timing frozen and no human
resume action: continuation is automatic when a dispatcher next runs. Repository event history is
shown once. It is read-only and also reports an idle or paused repository with
no run. The dispatch header always shows its acknowledged `harvest ON/OFF` gate
and global `h` controls it. The optional, non-color-only `Harvest` row omits the
internal run id and represents one deterministically selected open run or
unresolved attention; its contextual `p` issues the repository-wide resume or
acknowledgement; `l` / `o` merge controls apply only to builds.

### Status, durable progress, and lease health are separate

These are **three independent axes**, and reading one as another is the mistake
worth avoiding.

**Status** is reduced from the event log (§15.5) — authoritative, and the same
projection the engine itself routes on. **Durable progress** is the timestamp of
the latest reduced event; its age says how long the log has been silent.
**Lease health** comes from the mutable lease columns (§15.2.6), because
liveness is not an event: nothing appends when a sandbox dies, so a build whose
runner is gone still reduces to `running` forever. That gap is exactly why all
three are reported separately.

`diverged` is shown only when a nonterminal build has an unexpired lease and its
heartbeat is at least one hour newer than its latest event. Finished, aborted,
no-lease, and expired-lease builds are never marked. The marker does not alter
status, lease health, routing, or recovery.

| Lease | Meaning |
|---|---|
| `held` | A runner holds an unexpired lease. The runner is live; inspect `PROGRESS` to see when it last wrote a durable fact. |
| `expired` | The lease ran out — the runner is gone. `running` + `expired` is the **stale** case: the status is not lying, it simply has no "runner died" fact to record. Re-attachment depends on the current engine decision: the lease sweep re-attaches actionable runner work, while a merged or closed PR awaits repository-level completion with no runner re-attachment pending. |
| `no-lease` | **Not necessarily dead.** A build that has not yet claimed its first lease reads this way, and the lease sweep deliberately grants an absent lease a first-claim grace window before acting. A freshly launched build is the common case — read it together with progress, not alone. |

So `running` + `held` confirms liveness, while its progress age says whether
the durable log is moving. For `running` + `expired`, inspect the build detail
to distinguish actionable work that will return through the lease sweep from
an ended PR awaiting repository-level completion. `no-lease` with recent
progress is usually a runner still starting up.

## Serving the operator tools over MCP

`ab mcp [--store <ref>] [--repo <id>]` serves Autobuild's operator tool
registry as an MCP (Model Context Protocol) server over stdio. Every tool it
advertises mirrors an operator CLI command or an operator API route — same
input schemas, same annotations, same results — and mutating tools attribute
their writes to the sessionless operator identity (USER/USERNAME, else
"dashboard"), exactly like the other operator commands. The server fails
closed inside a phase session: repository-wide operator authority cannot be
narrowed to the ambient build, so a complete or malformed `AB_*` phase tuple
refuses to start it.

**The `ab` CLI stays the primary local interface** for agents that have a
shell. Use `ab mcp` when a local agent cannot run commands, for dogfooding the
operator tools, or for parity testing of the tool registry itself — the
served tools are generated from the same closed table the CLI and operator API
are measured against.

| Flag | Effect |
|---|---|
| `--store <ref>` | Override the BuildStore path or URL, same precedence as the other sessionless commands. |
| `--repo <id>` | Constrain the server to one repository; calls naming any other repository are refused. |

Register it with Claude Code (from an Autobuild installation root):

```sh
claude mcp add autobuild -- bun <install-root>/bin/ab.ts mcp
```

Register it with Codex by adding a server entry to `~/.codex/config.toml`:

```toml
[mcp_servers.autobuild]
command = "bun"
args = ["<install-root>/bin/ab.ts", "mcp"]
```

The server runs until its client disconnects (stdio EOF) and needs no
daemon: each client session starts one short-lived `ab mcp` process.

## The installed skills

Each is invoked as `ab-<name>`, with its editable copy at
`.agents/skills/ab-<name>/SKILL.md` (read that copy, not the distribution
default, when you need to know what this repo's version says).

| Skill | Place in the lifecycle | Purpose |
|---|---|---|
| `ab-spec` | Before a build exists | Design a feature spec-first through conversation, or flesh out a ticket to the spec standard. The human-interactive surface; takes a ticket, not a build slug. **Model-invocable.** |
| `ab-tickets` | Before a build exists | Drive this repo's local file tracker: create a ticket, report the backlog, groom or move one between the lifecycle directories (`triage/ ready/ doing/ done/`) and any repository-defined states, including the icebox. The agent-facing surface on the tracker — use it instead of `mv`. **Model-invocable.** |
| `ab-guide` | Outside the pipeline | This skill: reference for the lifecycle, config surface, setup/upgrade behavior, and the installed skills. Its editable `references/setup.md` guides the init handoff. **Model-invocable.** |
| `ab-harvest` | harvest `synthesize` step | Continue the producer across review rounds: cluster the claimed structured observations and author typed spec-standard create/join/suppress proposals. Runner-only. |
| `ab-harvest-review` | harvest `review` step | Fresh adversarial reviewer for proposal coverage, semantic dedup, spec quality, and evidence; returns `approve`/`revise`/`escalate`. Runner-only. |
| `ab-plan` | `plan` phase | Turn the spec into a plan another agent can implement without re-deriving the reasoning. Writes no product code. |
| `ab-plan-review` | `plan-review` phase | Fresh skeptic: review the plan against the spec, verdict `approve`/`revise`/`escalate`. |
| `ab-implement` | `implement` phase | Execute the approved plan as local commits plus deposited notes. Never pushes. |
| `ab-code-review` | `code-review` phase | Fresh skeptic: review the implementation diff against spec and plan, same verdict vocabulary. |
| `ab-reconcile` | `reconcile` phase (epilogue) | Resolve a kernel-prepared single-change replay onto a frozen refreshed base; the kernel archives evidence and publishes with an exact expected-head guard. |
| `ab-finalize` | `finalize` phase | Write the PR description for a green build; the kernel opens the PR. |
| `ab-operate` | outside the pipeline; model-invocable | The operator agent’s operating manual, for any agent: file and groom tickets, operate the builds the repository's dispatcher dispatches with a registered `ab watch --operator` loop, answer escalations, pause, resume, abort, control merge consent and holds, and adopt new builds until the human ends or hands off the role. MCP presence is deferred. |

Autobuild installs 12 skills. Everything except `ab-spec`, `ab-tickets`,
`ab-guide`, and `ab-operate` carries `disable-model-invocation: true` — do not
invoke a phase skill yourself, and do not remove that key to make one
convenient to call. A model starting a pipeline phase by pattern-matching a
description is exactly what the flag prevents. Those four exceptions drive no
build phase, which is the criterion for membership (§16.3): `ab-spec` and
`ab-tickets` are human/agent-facing pre-build surfaces, `ab-guide` is
read-only reference including the setup handoff guidance, and `ab-operate` is
the manual for the operator-agent role, which any agent may take on.

## Revision-checked ticket writes

Every ticket read includes an opaque `revision`. Pass it as `expectedRevision`
(on MCP/operator requests) or `--expected-revision <opaque>` on `ab ticket update`,
`move`, `block` and `unblock`. A stale write fails without changing anything and
reports the current revision. Omission preserves unguarded behavior. Blocker
checks cover the entire batch. Dispatcher moves remain unguarded and change the
revision. Sources without guarded writes, including Linear, refuse supplied
revisions rather than ignoring them.

`ab ticket edit <id>` opens `$VISUAL`, falling back to `$EDITOR`, using TOML
frontmatter and a Markdown body. Only title, body and labels are editable;
kind, target, id, blockers, creation key and reference comments are read-only. It saves only
changed fields with the opening revision. Unchanged or formatting-only edits
write nothing. On conflict, invalid input or editor failure, the error names an
absolute file path containing the edited text. Read the current ticket and
reapply the intended changes before retrying; conflicts are never merged.

File and Linear revisions fingerprint kind, target, title, body, canonical label/blocker sets
and state; reverting identical content restores its fingerprint. File checks
re-read immediately before writing, with the existing no-lock race window.
Direct file edits and state-directory moves change revisions. File revisions also
cover structured comments and portable attachments. Legacy file comments change
the body; structured comments preserve it. Separate hosted comments do not change
ticket revisions. Hosted revisions
are monotonic decimal bigint strings, and checks run under the same row lock
and transaction as all requested changes. Hosted reads return a coherent
snapshot of fields, blockers and revision.

Read before writing, and copy the opaque revision verbatim:

```sh
ab ticket show AUT-8 --json
ab ticket update AUT-8 --title 'Revised title' --expected-revision '<revision from show>'
ab ticket edit AUT-8
```

Use `expectedRevision` on MCP `tickets.update`, `tickets.move`, `tickets.block`
and `tickets.unblock` with the revision from `tickets.get` or `tickets.list`.

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
[node polling and status](references/integration-tree.md#polling-and-status).

The total includes all attempted requests. Optional `restPrimary`,
`restNotModified` and `graphql` counts distinguish REST responses charged to the
primary quota, REST 304s and GraphQL calls. Transport failures and historical or
legacy observations can remain unclassified; absent fields never imply zero.
Shared requests are attributed to their first requester; cache hits count zero.

### Requesting node freshness

`ab restack <node>` and `builds.restack {repo, slug}` record durable demand.
Paused or blocked nodes wait for normal safety gates; leaves, terminal nodes
and unopened nodes are refused. Collecting nodes may intentionally trail their
parent; both dashboards show its commit distance, current, or unknown.
See [restacking timing and recovery](references/restacking.md) for the five
automatic and explicit demand points, minimal presence paths and upgrade behavior.

### `[landing]`

Deprecated config spelling for `[merge]` / `[[merge]]`; see the
[compatibility notes](references/merge-policy.md#deprecated-spellings). Never
declare both spellings, including empty arrays. `ab upgrade` migrates this key.
