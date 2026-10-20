# RFC 0003 — Dispatcher hot upgrade

**Status:** draft, 2026-10-20. Parked: not ticketed until RFC 0002's
version-tolerant reads (AUT-866) has landed, which this design depends on.

**Hat:** product. Every change here ships to every user. This repository's
self-hosted source mode (§6.3) is a product mode, because any adopter running
Autobuild from a checkout uses it. Configuring this repository to use it is
this repository's own concern.

## 1. Problem

Upgrading Autobuild means restarting `ab dispatch`. A restart interrupts every
in-flight build. Since AUT-855 a clean stop suspends live agent sessions and
the restart resumes them natively, so no work is lost. The operator still has
to:

- notice that an upgrade is available;
- pick a quiet moment, and with many builds in flight there may never be one;
- stop the dispatcher, install the new version and start it again;
- pay to resume every interrupted session, since resuming re-sends each
  conversation to the model.

Painful upgrades mean rare upgrades. Adopters drift behind the release line,
lose fixes, and eventually face a large, risky jump. In this repository,
where `main` changes Autobuild itself several times a day, a dispatcher
left on old code has repeatedly stopped all work. That happened on
2026-10-18 and twice on 2026-10-20, as RFC 0002 §1 records.

## 2. Summary of the proposal

1. **A stable launcher.** `ab dispatch` becomes a small, rarely changing
   launcher. It owns the terminal and signals, holds no leases, and runs
   dispatcher *generations*. A generation is the frontend and the kernel,
   loaded from a resolved runtime (§3).
2. **Generation handoff that drains.** When the target runtime changes, a new
   generation starts beside the old one and preflights. It then takes the
   repository lease. The old generation keeps only its runners' execution
   leases while they finish their current phases, then exits (§4).
3. **Runners swap at phase boundaries.** A long-lived build-runner checks its
   runtime between phases and relaunches on the current one (§5).
4. **Runtime resolution.** The dispatcher runs the version the repository
   pins on its base branch, from its own runtime cache. An explicit upgrade
   request covers every mode, and this repository gets a source-checkout
   mode (§6).
5. **Rollback.** A cached last-good runtime makes a failed upgrade recoverable
   without operator intervention (§7).

## 3. The launcher

`ab dispatch` keeps its user-facing behavior: arguments, dashboard, signals and
exit codes. Internally it is split:

- The **launcher** resolves a runtime, spawns a generation from it, relays
  signals, restores the terminal, and supervises generations. It takes no
  repository or execution lease and makes no kernel decisions.
- A **generation** is today's frontend and kernel pair, running entirely from
  one runtime. The dashboard belongs to the generation. When a generation is
  replaced, the screen redraws from the store, which already drives it.

The launcher-to-generation contract is small and versioned: spawn arguments,
an environment marker, the signal semantics, and a structured exit reason
(`stopped`, `handoff`, `failed`). That way an older launcher can run a newer
generation. A change to the contract itself requires restarting the launcher
by hand, which should be rare and is called out in release notes when it
happens.

The launcher communicates with generations only through process lifecycle and
the store. That follows core rule 5: no private channel between Autobuild
processes.

## 4. Generation handoff

### 4.1 Sequence

When the launcher's resolved target runtime differs from the running
generation's (§6):

1. **Prepare.** The runtime cache installs the target runtime if it is
   missing (§6.4).
2. **Preflight.** A new generation starts in preflight mode. It validates
   configuration, opens the store, checks store protocol and schema
   compatibility, and checks that no migration requires exclusive access. If
   preflight fails, it exits and the old generation keeps running. A
   repository attention record names the target version and the reason.
3. **Takeover.** The new generation claims the repository lease, which the
   old generation yields on a durable handoff request. From then on, the new
   generation alone ticks, claims tickets, runs the janitor and harvest, and
   launches runners.
4. **Drain.** The old generation enters `draining`. It holds only the
   execution leases of runners it already supervises. Each runner finishes
   its current phase on the old code, releases its lease and exits. The new
   generation sees the released lease and relaunches the build from durable
   state on the new runtime, at its next phase.
5. **Drain deadline.** After `policy.upgradeDrainSeconds` (proposed default
   15 minutes), the old generation suspends every session still live, which
   is a clean stop under AUT-855, and exits. The new generation resumes those
   sessions natively.
6. **Complete.** The handoff is recorded as repository facts: the target
   version, start and end times, how many builds drained, and how many were
   suspended at the deadline.

Most builds never see an interruption, because phase boundaries are frequent.
Only a phase longer than the deadline is suspended, and then it resumes where
it stopped.

### 4.2 Why the existing lease model fits

The repository lease (ticks, claims, harvest) and per-build execution leases
are already separate. Execution leases are already the exclusivity gate for a
build: a new dispatcher "attempts every actionable build on its first tick …
lease claiming stays the exclusivity gate". Handoff therefore needs a draining
holder state for the old generation and a durable yield request. It needs no
new coordination mechanism.

### 4.3 Incompatible jumps

Some upgrades cannot overlap two generations:

- a store migration that needs exclusive access;
- a change of the hosted service's protocol line;
- a launcher contract change.

Preflight detects these and switches to a **cutover** instead. The old
generation suspends all sessions, which costs a native resume for each one,
and exits. The new generation then starts. Cutover is still automatic.

### 4.4 Dependency on version-tolerant reads

During a drain, old runners and the new generation write the same build and
repository logs in both directions. Without RFC 0002 §4, an old reader that
meets a newer fact fails closed, and the handoff reproduces exactly the
outages it is meant to remove. This RFC is not implementable before AUT-866.

## 5. Runner swap at phase boundaries

A build-runner process can live through many phases of one build. At each
phase boundary it compares its runtime with the runtime its supervising
generation launches. If they differ, it exits with a `relaunch` reason. The
current generation relaunches it on the current runtime, from durable state.
No phase is ever split across runtimes except by the drain-deadline suspend,
which resumes natively.

The build log records which runtime ran each phase, as a session or phase
fact. That makes it possible to correlate a regression with a version.

## 6. Runtime resolution

### 6.1 Modes

`[dispatch].runtime` selects how the target runtime is resolved:

- **`installed`** (today's behavior, and the default until this RFC is
  accepted): the runtime is whatever `ab` resolved to when the launcher
  started. An upgrade happens only through an explicit request (§6.2), or by
  restarting.
- **`pinned`**: the runtime is the exact `@defrex/autobuild` version that the
  repository pins on its base branch (`package.json`, resolved through its
  lockfile). Upgrading Autobuild becomes merging a PR that bumps the dev
  dependency, whether a human, Renovate or an Autobuild build opens it. The
  dispatcher reads the pin from the base branch's tip, never from the working
  tree, so checking out a branch in the main checkout never changes what
  the dispatcher runs.
- **`source`**: for running Autobuild from a source checkout, as this
  repository does. The runtime is a managed checkout of the base branch's
  tip, kept apart from any working tree an operator or agent edits.
  Advancing the base branch advances the runtime. That removes the "never
  pull the root checkout under a running dispatcher" hazard entirely.

### 6.2 Explicit requests

In every mode, `ab upgrade` and an operator tool of the same shape record a
durable **upgrade-requested** repository fact, with an optional target
version. The launcher acts on it. Orchestrating agents can then request an
upgrade without managing processes, which keeps the `ab-operate` boundary:
agents never start or stop a dispatcher.

### 6.3 Trust

In `pinned` and `source` modes, merged code changes the code the dispatcher
runs, and does so automatically. Merged code already changes everything else
in the repository, but this extends its reach to the orchestrator itself.
Mitigations:

- Following the base branch is opt-in until a release proves it.
- The recommended landing policy for repositories using `pinned` adds a
  consent rule for changes to the Autobuild dependency pin. `ab-guide`
  documents that rule.
- Every generation start records its runtime version and source.

### 6.4 The runtime cache

Runtimes are installed into `.autobuild/runtime/<version>/`, or
`<commit>/` in source mode, by the dispatcher, never into the operator's
working tree. Installation uses the repository's package manager and
registry configuration, offline when the version is already cached. The cache
keeps the running runtime, the previous runtime, and any runtime pinned by
§7. Older entries are pruned.

## 7. Rollback

If a new generation exits `failed` repeatedly within a short window after
takeover (proposed: three times in ten minutes), the launcher relaunches the
previous runtime from the cache and records a rollback. It also raises an
attention record naming the failed version and holds that version until a
newer target appears or an operator requests it explicitly. Builds already
relaunched on the failed runtime resume on the previous one at their next
boundary, under the same version-tolerant reads.

## 8. Operator surfaces

- `ab upgrade [--version <v>]`, the durable request in §6.2.
- `ab repository status` shows the launcher and generation versions, the
  runtime mode, any handoff in progress (draining builds, deadline), and the
  last rollback.
- `ab watch` default attention gains handoff preflight failure, rollback, and
  "upgrade available but held" in `installed` mode, if update notices are
  enabled.
- The dashboards show a handoff banner and a per-build `draining` marker,
  through the shared projection.

## 9. What does not change

- The hosted dispatcher. Each cron invocation already loads fresh code.
- Build semantics. Phases, events and resumption are unchanged. A build
  cannot tell whether its next phase runs on a new generation, except from
  the recorded runtime fact.
- Configuration reload. Deployment-owned sections still reload live within a
  generation.

## 10. Open questions

1. **Drain or immediate suspend by default?** Proposed: drain with a 15-minute
   deadline. Immediate suspend is simpler, but costs a native resume for every
   live session on every upgrade.
2. **Should `pinned` become the default for new repositories once proven?**
   Proposed: yes, since it matches the project-pinned install recommendation.
   That is decided by a later disposition, not by this RFC.
3. **Can the launcher upgrade itself?** Proposed: no, a contract change
   requires a manual restart. An `exec`-style self-replacement is possible on
   POSIX, but buys little for something designed to change rarely.
4. **Should multiple repositories on one machine share runtimes?** Out of
   scope. The cache is per repository.

## 11. Delivery plan (after AUT-866)

1. The launcher/generation split, the `ab upgrade` durable request, and a
   cutover-only handoff (§4.3) in `installed` mode. This already makes an
   upgrade a single command.
2. Draining handoff with preflight and the drain deadline (§4.1).
3. Runner swap at phase boundaries and per-phase runtime facts (§5).
4. The runtime cache and rollback (§6.4, §7).
5. `pinned` and `source` modes (§6.1), with the `ab-guide` consent-rule
   recommendation.

## Evidence

- Maintainer discussion, 2026-10-20 session: restarting the dispatcher is
  painful with many builds in flight, which makes upgrading punishing and
  rare. The proposal is a stub that detects version changes and hot-swaps.
- RFC 0002 §1 item 5: mixed-version outages on 2026-10-18 and 2026-10-20.
- AUT-855 (#664): a clean dispatcher stop suspends live sessions, and a
  restart resumes them natively. That is the fallback this design relies on.
- `SPEC.md` §3: the shipped interactive terminal owns a supervised kernel
  child, and the BuildStore is their only changing-state boundary. Also
  §15.6: runner execution leases and the repository lease are separate.
