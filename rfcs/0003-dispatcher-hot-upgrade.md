# RFC 0003 — Dispatcher hot upgrade

**Status:** accepted for 1.0, 2026-10-21. Built by the "Hot upgrade for 1.0"
integration node and its children. Each child amends `SPEC.md` for the
section it builds; until then `SPEC.md` describes the running system.

**Hat:** product. Every change here ships to every user. Source mode (§6.3)
is a product mode, because any adopter running Autobuild from a checkout uses
it. Moving this repository's own dispatcher procedure onto it is this
repository's configuration and is filed separately inside the same node.

## 1. Problem

Upgrading Autobuild means restarting `ab dispatch`. A restart interrupts every
in-flight build. Since AUT-855 a clean stop suspends live local agent sessions
and the restart resumes them natively, so no work is lost. The operator still
has to:

- notice that an upgrade is available;
- pick a quiet moment, and with many builds in flight there may never be one;
- stop the dispatcher, install the new version and start it again, on every
  machine that runs one, which with several operators means coordinating
  people;
- pay to resume every interrupted session, since resuming re-sends each
  conversation to the model.

Painful upgrades mean rare upgrades. Adopters drift behind the release line,
lose fixes, and eventually face a large, risky jump. In this repository,
where `main` changes Autobuild itself several times a day, a dispatcher
left on old code has repeatedly stopped all work. That happened on
2026-10-18 and twice on 2026-10-20, as RFC 0002 §1 records.

A second, quieter hazard exists today. Build runners load their code from disk
when they start, and `ab upgrade` rewrites the installed package in place. A
dispatcher still running old kernel code can therefore start runners on new
code. The same happens in a source checkout when `main` is pulled under a
running dispatcher.

## 2. Goal and summary

The goal, set by the maintainer for 1.0: once someone has installed 1.0,
every later `ab upgrade` takes effect without anyone restarting a dispatcher
or managing in-flight builds, on every machine that runs one.

1. **The dispatcher notices upgrades itself.** Nothing pushes an upgrade to a
   running dispatcher. A running dispatcher resolves its target runtime from
   durable sources, chiefly the version the repository pins on its base
   branch, and hands off when that target changes (§6). `ab upgrade` keeps its
   job, which is to update the pin and the vendored skills and commit them.
   It does not push. Once that commit reaches the base branch, every
   dispatcher for the repository upgrades.
2. **A frozen launcher.** `ab dispatch` becomes a small launcher that runs
   dispatcher *generations*. The launcher shipped in 1.0 is the one piece
   that is not hot-upgraded, so it is deliberately minimal (§3).
3. **Immutable runtimes.** Generations and their runners load code only from
   an immutable runtime directory in a per-repository cache, never from the
   operator's working tree or a package install that something else mutates
   (§6.4).
4. **A handoff that drains.** A new generation starts beside the old one,
   preflights and takes the repository lease. The old generation only
   supervises its runners until they reach a phase boundary, then exits (§4).
5. **Runners swap at phase boundaries.** A runner checks the current target
   runtime between phases and relaunches on it, locally and in remote
   sandboxes (§5).
6. **Rollback.** A new generation that keeps failing right after takeover is
   replaced by the previous one, and the failed version is held (§7).

## 3. The launcher

`ab dispatch` keeps its user-facing behavior: arguments, dashboard, signals and
exit codes. Internally it is split:

- The **launcher** owns the terminal and the operator's signals, starts a
  generation from a runtime directory, supervises it, starts the next
  generation when a handoff begins, and rolls back on repeated early failure
  (§7). It takes no repository or execution lease, makes no kernel decision,
  and decides nothing about which version should run.
- A **generation** is today's dispatcher, the frontend and kernel pair, running
  entirely from one runtime directory. Target resolution, cache installation,
  preflight, drain and the dashboard all live in generations, so later
  releases can change them without a manual restart.

The launcher loads all of its code when it starts. Replacing the installed
package under a running launcher must not change its behavior.

The launcher-to-generation contract is small and versioned: launch arguments,
an environment marker, signal semantics, and a structured exit reason
(`stopped`, `handoff`, `failed`). An older launcher can run a newer generation
whenever the contract version matches. A contract change requires restarting
the launcher by hand; it should be rare and is called out in release notes.
Upgrading from a pre-1.0 release to 1.0 is itself such a restart.

Communication follows core rule 5. The launcher and its generations share
process lifecycle, launch arguments and durable store state, and nothing else.
The launcher links no store code: when it needs durable state, such as the
runtime a handoff targets, it reads it through the current generation's
runtime, whose output format is part of the versioned contract.

Only one generation draws the dashboard at a time. When a handoff begins, the
new generation takes the screen and the draining generation stops drawing.
The screen redraws from the store, which already drives it.

All long-running modes go through the launcher: the interactive dashboard and
`--plain` or non-interactive watch mode. `--once` runs a single tick and has
nothing to upgrade. The hosted cron dispatcher (origin mode) is unchanged,
because each invocation already loads fresh code.

## 4. Generation handoff

### 4.1 Sequence

When a generation's resolved target runtime differs from its own (§6):

1. **Prepare.** The running generation installs the target into the runtime
   cache if it is missing (§6.4) and records that an upgrade was detected,
   naming both runtimes.
2. **Preflight.** The launcher starts the new generation in preflight mode. It
   validates configuration, opens the store and checks that it can share it
   with the running generation (§4.3). If preflight fails, it exits, the old
   generation keeps running, and a repository attention record names the
   target and the reason. The old generation does not retry the same target
   until it changes or the operator restarts.
3. **Takeover.** The new generation records a durable yield request. The old
   generation yields the repository lease without tearing down its builds, and
   the new generation claims it. From then on, the new generation alone
   ticks, claims tickets, runs the janitor and harvest, and launches runners.
   Losing the repository lease to a handoff is distinct from being superseded
   by a stranger, which keeps today's behavior.
4. **Drain.** The old generation enters `draining`. It keeps supervising the
   runners it already has, and their execution leases, and does nothing else.
   Each runner finishes its current phase on the old code and exits for
   relaunch (§5). The new generation relaunches the build from durable state
   on the new runtime.
5. **Drain deadline.** After `policy.upgradeDrainSeconds` (default 900), the
   old generation suspends every local session still live, which is a clean
   stop under AUT-855, and exits. The new generation resumes those sessions
   natively. Remote sandbox runners are detached and hold their own leases, so
   the old generation never waits for them (§5.2).
6. **Complete.** The handoff is recorded as repository facts: both runtimes,
   start and end times, how many builds drained, and how many were suspended
   at the deadline.

Most builds never see an interruption, because phase boundaries are frequent.
Only a phase longer than the deadline is suspended, and then it resumes where
it stopped.

### 4.2 What the lease model already provides, and what it lacks

The repository lease (ticks, claims, harvest) and per-build execution leases
are already separate, and execution leases are already the exclusivity gate
for a build. What is missing: the repository lease has a single holder and no
durable yield request; losing it today marks the dispatcher superseded and
tears down every runner; and there is no draining state. §4.1 step 3 adds
those three things.

### 4.3 Incompatible jumps: cutover

Some upgrades cannot overlap two generations:

- a store schema change the running generation cannot share, such as a
  Postgres schema version bump (Postgres requires an exact schema version at
  open; the local SQLite store applies additive DDL);
- a target outside the hosted store's supported client window;
- a launcher contract change, which needs a manual restart anyway.

Preflight detects these and switches to a **cutover**. The old generation
suspends every local session and exits, the new generation starts, and the
sessions resume natively. Cutover is still automatic. It is also the first
handoff the series builds, before draining exists.

A clean stop must actually complete session suspension before the old
generation's process tree is gone. Today the kernel-stop timeout and the
runner process-group stop timeout run concurrently, so a slow suspension can
be cut short; cutover fixes that.

### 4.4 Version-tolerant reads during a drain

During a drain, old runners and the new generation write the same build and
repository logs. RFC 0002 §4 (AUT-866, merged) makes an older reader skip
newer facts it does not know and defer kernel decisions when a skipped fact is
*decisive*, raising an attention record that asks for a restart. During a
handoff that deferral is expected, not an operator problem: a draining runner
that defers on a newer decisive fact exits for relaunch on the current runtime
and raises no restart attention.

## 5. Runner swap at phase boundaries

### 5.1 Local runners

A build-runner process loops through many phases of one build. At each phase
boundary it compares its own runtime with the repository's current target
runtime, read from the store. If they differ, it exits with a `relaunch`
outcome. The generation holding the repository lease relaunches it on the
current runtime, from durable state. No phase is split across runtimes except
by the drain-deadline suspend, which resumes natively.

The build log records which runtime ran each phase, through the runner's attach
facts, and the repository log records which runtime each generation ran. That
makes it possible to correlate a regression with a version.

### 5.2 Remote sandbox runners

Remote runners already follow the dispatcher's code. Every guest relaunch or
re-attach compares the guest's installed distribution with the launching
generation's exact archive and reinstalls on a mismatch (#501, AUT-600). Two
things are added:

- The phase-boundary check of §5.1 reads the target from the store, so the same
  runner code relaunches inside a guest. The relaunch goes through the existing
  re-attach path and reinstalls the guest.
- A generation running from a cached registry install has no source checkout,
  so it supplies the guest archive from the version's published release asset,
  which origin mode already does.

The hosted store accepts clients two minor versions back and one forward, so a
guest finishing a phase on the old version is served normally. A jump outside
that window is a cutover (§4.3).

## 6. Runtime resolution

### 6.1 Modes

A generation resolves its target runtime in one of three modes, inferred from
how Autobuild is installed:

- **`pinned`** (the default when the repository declares `@defrex/autobuild`
  as a dependency): the target is the exact version the repository pins on its
  base branch tip, through `package.json` and its lockfile, as the forge has it.
  The dispatcher never reads the pin from the working tree, so checking out a
  branch in the main checkout never changes what it runs. Upgrading Autobuild
  becomes merging a commit that bumps the dependency, whether `ab upgrade`, a
  human, Renovate or an Autobuild build made it.
- **`installed`** (the fallback when the repository pins nothing, such as a
  global install): the target is the version of the install the launcher was
  started from. Replacing that install, with `ab upgrade` or the package
  manager, is noticed.
- **`source`** (when Autobuild runs from a source checkout of the repository it
  dispatches, as this repository does): the target is the base branch tip, as
  a managed checkout kept apart from any working tree an operator or agent
  edits. A base branch advance that changes nothing in the packaged
  distribution does not start a handoff.

Automatic upgrades are on by default. A repository can turn them off in
`autobuild.toml`, which returns the dispatcher to today's behavior: it runs the
runtime it started with until restarted.

### 6.2 `ab upgrade`

`ab upgrade` is unchanged in what it does: it updates the pin and lockfile,
merges vendored skills and commits what it owns. It never pushes. Its output
says what happens next: in `pinned` mode, every dispatcher for the repository
upgrades once the commit reaches the base branch; in `installed` mode, the
dispatcher on this machine upgrades on its own.

### 6.3 Trust

In `pinned` and `source` modes, merged code changes the code the dispatcher
runs. Merged code already changes everything else in the repository, and a
pin bump goes through the repository's normal review and landing policy.
Every generation start and every handoff records both runtimes and where they
came from, and the opt-out in §6.1 exists for repositories that want
restarts to stay manual.

### 6.4 The runtime cache

Runtimes are installed into `.autobuild/runtime/<version>/`, or
`<commit>/` in source mode, by a generation, never into the operator's
working tree. Installation uses the repository's package manager and
registry configuration, offline when already cached. A runtime directory never
changes after it is installed. The cache keeps the running runtime, the
previous runtime, and any held version (§7). Older entries are pruned.

## 7. Rollback

If a new generation exits `failed` repeatedly within a short window after
takeover (three times in ten minutes), the launcher starts the previous
runtime from the cache again and tells it, through launch arguments, which
version failed. That generation records the rollback, raises an attention
record naming the failed version, and holds that version: it does not target
it again until the resolved target changes to something else or an operator
restarts the dispatcher.

Builds that ran a phase on the failed version continue on the previous one at
their next boundary. A build where the failed version wrote a decisive fact
the previous version cannot read is deferred with attention under RFC 0002 §4,
not acted on blindly.

## 8. Operator surfaces

- `ab repository status` shows the launcher contract version, the running
  generation's runtime and mode, any handoff in progress (draining builds,
  deadline), and the last rollback.
- `ab watch` default attention gains handoff preflight failure and rollback.
- The dashboards show a handoff banner and a per-build `draining` marker,
  through the shared projection.
- `ab-operate` and `ab-guide` stop telling operators and agents to restart the
  dispatcher after an upgrade, except for a launcher contract change.

## 9. What does not change

- The hosted cron dispatcher. Each invocation already loads fresh code.
- Build semantics. Phases, events and resumption are unchanged. A build
  cannot tell whether its next phase runs on a new generation, except from
  the recorded runtime facts.
- Configuration reload. Deployment-owned sections still reload live within a
  generation.

## 10. Decisions

Settled by the maintainer on 2026-10-21:

1. The running dispatcher detects upgrades; nothing pushes them. `ab upgrade`
   keeps its name and job and does not push commits.
2. Automatic upgrades are on by default in 1.0, in every mode, with an opt-out.
3. Drain with a 15-minute deadline, not immediate suspend.
4. The launcher cannot upgrade itself. A contract change requires a manual
   restart.
5. Remote sandbox runners are in scope.
6. The runtime cache is per repository.

## 11. Delivery plan

All children of one integration node, landing into `main` by consent:

1. Record runtime identity on generation starts and runner attaches.
2. The launcher, generations and the immutable runtime cache.
3. Target resolution in `pinned` and `installed` modes, with cutover handoff.
4. Draining handoff: preflight, lease yield, drain deadline.
5. Runner relaunch at phase boundaries, local.
6. Runner relaunch for remote sandbox runners.
7. `source` mode.
8. Rollback.
9. Dashboard handoff banner and draining marker.
10. This repository's configuration: its self-hosting procedure.

## Evidence

- Maintainer discussion, 2026-10-20 session: restarting the dispatcher is
  painful with many builds in flight, which makes upgrading punishing and
  rare.
- Maintainer decisions, 2026-10-21 session: "when somebody installs 1.0 for
  the first time, going forward when they run ab upgrade, the system upgrades
  itself without them needing to manually restart the dispatcher or
  micromanage any active builds"; coordinating dispatcher restarts "across
  many machines and potentially many different people" is the pain point; the
  dispatcher should notice the version change rather than have it pushed; no
  push in `ab upgrade`; remote sandbox runners should be equally smooth.
- RFC 0002 §1 item 5: mixed-version outages on 2026-10-18 and 2026-10-20.
- AUT-855 (#664): a clean dispatcher stop suspends live local sessions, and a
  restart resumes them natively.
- AUT-866 (#676): version-tolerant reads with advisory and decisive facts.
- #501 and AUT-600 (#544): guests are reinstalled to the launching
  dispatcher's exact archive on every restart and re-attach.
- `SPEC.md` §3.3: one build-runner process per build, looping across phases.
  §15.6: runner execution leases and the repository lease are separate.
