# Hosted dispatcher cutover validation — AUT-320

- **Validation run:** 2026-09-11, window 19:06:24Z – 19:41:52Z; verification re-derived from fresh Store snapshots at 22:41Z and again at 23:29Z after the implement phase re-ran in a fresh workspace (the durable log below is live and keeps accumulating)
- **Build:** `validate-hosted-dispatcher` on `https://autobuild.defrex.com` (durable event log: `GET /builds/validate-hosted-dispatcher/events` or the web dashboard)
- **Branch:** `ab/validate-hosted-dispatcher` (PR publication requested with auto-merge; publication and merge happen after the implement session — the build slug carries the final merged state)
- **Tickets:** [AUT-320](https://linear.app/issue/AUT-320) (this validation), [AUT-304](https://linear.app/issue/AUT-304) (acceptance evidence attached to its body)
- **Method note:** all numbers below were re-derived from fresh Store snapshots at implement time, at the guidance round (repository journal seq 1–926, build event log seq 1–45, as of 2026-09-11T22:41Z), and again at 23:29Z on the re-run implement session (journal seq 1–1117, build event log seq 1–60). Snapshots are labeled as-of; the durable event log is authoritative.

## Checklist verdicts

| Checklist item | Verdict | Evidence |
| --- | --- | --- |
| Environment variables set | ✅ | Hosted ticks deposit `dispatcher-effective-config` artifacts (rev 50 as of 19:54:50Z) declaring workspace provider `vercel-sandbox`, env var `AI_GATEWAY_API_KEY`, AI-gateway model sessions (`vercel-ai-gateway/zai/glm-5.3-flash`, `vercel-ai-gateway/meta/muse-spark-1.3`), and runtime provisioning with preflight checks. Every hosted tick since 19:06 completes and deposits the artifact. |
| Cron live | ✅ | 265 `dispatcher.run-started` events at ≈60 s median cadence from 19:06:24Z through 23:28:50Z (latest snapshot), all run ids `hosted-dispatcher-<uuid>`, all 265 ending `run-stopped outcome=normal`. |
| Harvest gate off | ✅ | Last `harvest.completed` at 03:05:04Z (journal seq 59); no `harvest.*` event since. |
| Local `ab-dispatch-kernel` stopped on every maintainer machine | ✅ (store-side layers + maintainer attestation with attached evidence) | Three-layer verification below. The store-side layers prove no interactive local dispatcher ever wrote to this repository and no dispatcher of any mode claimed build work in the window; the process-level residue on maintainer machines is covered by the maintainer's attestation with attached command output (see Process evidence). |

## Three-layer verification

The journal alone cannot prove absence of local dispatchers: only the interactive
frontend's child kernel carries a `kernelRunId`, so a headless local run
(`ab dispatch --once --plain`) writes no `dispatcher.run-started`/tick events at
all. The verification therefore stacks three bounded layers.

### Layer 1 — Repository journal (proves: hosted cadence live; no *interactive* local dispatcher)

Journal seq 1–1117, complete from 2026-09-11T02:17:59Z (no gaps; the hosted
repository store came up that morning). Re-derived 22:41Z and again 23:29Z.
Findings:

- 265 `dispatcher.run-started` events — **every one** with run id prefixed
  `hosted-dispatcher-`; zero bare-UUID (interactive local) run ids in the
  entire journal history.
- Cadence ≈60 s median (min 11 s, max 63 s; first 19:06:24Z, last in snapshot
  23:28:50Z); 265/265 `run-stopped` with `outcome=normal`.
- The only two `dispatcher.tick-yielded` events (seq 144, 19:25:50Z; seq 1111,
  23:27:52Z) are both hosted→hosted (run/holder ids all `hosted-dispatcher-*`).
- No `harvest.*` event after 03:05:04Z (none after the window opened).
- Zero journal events mention any maintainer hostname (`aron-desktop` does not
  appear anywhere in the journal).

**Bound:** proves nothing about headless local dispatchers, which never write
journal events.

### Layer 2 — Build-scoped execution facts (proves: no dispatcher of *any* mode claimed work in the window)

A dispatcher that actually claims and works a build writes build-scoped facts
regardless of interactive/headless mode: `workspace.provision-started` and,
decisively, `execution.started` whose `instance` is
`${hostname()}-${slug}-inst_<id>` — a plain store append, never gated on
`kernelRunId`. The hosted deployment stamps the Vercel function's hostname
(link-local `169.254.x.x` form); a maintainer machine's dispatcher would stamp
its own hostname.

- Build census (store `GET /builds`): the only build created after the window
  opened is `validate-hosted-dispatcher` (19:06:33Z); no older build was
  updated during the window (re-derived 22:41Z and again 23:29Z).
- This build's `execution.started` events both stamp hosted instances:
  seq 21 (19:26:06Z, generation 0)
  `instance=169.254.67.163-validate-hosted-dispatcher-inst_e031dd81`,
  `provider=vercel-sandbox`, `sessionId=sbx_d4pBpd0TAJQyKxBW0setr3e8F7sE`;
  seq 56 (23:28:09Z, generation 1)
  `instance=169.254.30.93-validate-hosted-dispatcher-inst_d69843ce` —
  the hosted host component in both cases.
- Zero `execution.started` events with a foreign hostname in the window;
  zero `workspace.provision-started` events anywhere in the store's builds
  outside this build during the window.

**Bound:** an idle local dispatcher that claims nothing still leaves no trace;
that residue is covered by Layer 3.

**Recovery-fact caveat (recorded for honesty):** `infrastructure.failed`
recovery facts carry the fixed instance name `dispatcher-recovery` and are
attributed to the supervising (hosted) tick, so they are bounded by the hosted
tick cadence rather than their own instance string. This build's three
`infrastructure.failed` events are all provision failures of the incident
below.

### Layer 3 — Maintainer-machine process evidence (supplied by the maintainer)

An idle local `ab dispatch` process that claims nothing leaves no store trace,
so this layer cannot be derived from the Store. The implementer escalated
(`esc_e93b2831`, raised from this build) asking the maintainer to run, on every
maintainer machine during the window, `pgrep -fl "ab-dispatch-kernel|ab
dispatch"` plus scheduler listings (launchd/cron/systemd user timers) and
attach the output to the escalation answer. The maintainer answered with a
full attestation **and attached command output**, folded into the Process
evidence section below.

## Process evidence (maintainer attestation, escalation esc_e93b2831)

The maintainer collected the evidence at 2026-09-11T19:49Z on **aron-desktop**
— the **only** maintainer machine (Linux; there is no macOS or Windows
maintainer machine, so launchd/launchctl and PowerShell checks do not apply).
Summary of the attached evidence:

1. **Processes.** `pgrep -fl "ab-dispatch-kernel|ab dispatch"` found exactly
   two processes (1096539 `bun …/bin/ab.ts dispatch`, 1096573
   `bun …/bin/ab-dispatch-kernel.ts`), both started 19:39:54Z, both with
   working directory `/home/defrex/code/parakeeto` — a **different
   repository's checkout** with its own Store repository identity. They cannot
   claim or supervise builds for `https://github.com/defrex/autobuild`. No `ab
   dispatch` process with cwd `/home/defrex/code/autobuild` exists.
2. **Last local dispatcher for this repository.** A headless `ab dispatch
   --plain --auto-merge` (kernel run id prefix `aron-desktop-*`) exited at
   18:06:13Z — its log ends "dispatcher superseded by another invocation —
   detaching / ab dispatch stopped" — 60 minutes **before** the validation
   window opened at 19:06Z. It was never restarted.
3. **User schedulers.** `crontab -l` → crontab is not installed on the machine
   (no user cron entries possible); `systemctl --user list-timers --all` → "0
   timers listed". No launchd (not macOS).
4. **Corroborating durable evidence.** Every `dispatcher.run-started` /
   tick / `run-stopped` fact for this repository from 19:06:24Z onward carries
   a `hosted-dispatcher-<uuid>` run id (first:
   `hosted-dispatcher-c5fa724f-fa11-4250-8dbb-3274510a2022`); no
   `aron-desktop-*` holder appears in the journal after 18:06Z. This build's
   own `execution.started` (seq 21) names instance
   `169.254.67.163-validate-hosted-dispatcher-inst_e031dd81` — a hosted
   function address, not a maintainer host.

**Maintainer conclusion (verbatim intent):** no local `ab dispatch` process for
this repository was running during 19:06–19:42Z, and none is running now.
Recorded as maintainer attestation with the attached outputs; the store-side
Layers 1–2 independently prove no dispatcher of any mode claimed or executed
build work in the window.

## Provision incident (honest record)

The first three provision attempts failed with
`Executable not found in $PATH: "bun"` (19:06–19:15Z) — the exact symptom
`docs/hosted-dispatcher.md` documents for a deployment that skipped
`pack-distribution`. After `maxInfrastructureAttempts` (3) was exhausted the
kernel raised escalation `esc_84b0cddf` (19:15:51Z, policy guard
`infrastructure-failure-limit`); the operator answered with a bare retry at
19:24:37Z, and provisioning succeeded at 19:25:51Z on the next hosted tick.
The generation-1 re-provision (23:26:54Z → 23:27:53Z, after the publication
note below) succeeded with no operator intervention.
**Verdict: the cutover works, with one operator intervention.** A follow-up
observation was recorded for the deployment's build/pack step.

## Publication note (honest record)

The implement phase requested publication at 22:43:01Z (event seq 49,
`publication.requested`; auto-merge had been requested at build creation,
seq 2). That first publication did not complete before the implement
workspace's environment lifetime ended: `execution.ended` at 23:26:51Z
(seq 51), the workspace was released, and a fresh generation-1 workspace was
provisioned for the re-run implement session. The prior workspace's un-pushed
commits were lost with it; store-side deposits (build artifacts, observations,
the escalation answer, the AUT-304 evidence section) persisted. This session
re-committed the repository deliverable (this document) and re-requests
publication. Publication, verify, review, and merge happen after this
session; the build slug `validate-hosted-dispatcher` carries the final state.
A follow-up observation was recorded for the publication path.

## Cutover outcome (as of implement time)

- Ticket moved to Todo → claimed and built by the hosted deployment alone:
  **confirmed** (Layers 1–2; single active build, hosted execution instances).
- Published as a PR, and merged: PR publication is **requested** (auto-merge
  requested at build creation; publication re-requested by this session) from
  branch `ab/validate-hosted-dispatcher` into `main`; verify, review,
  publication, and merge happen after this session, and the build slug
  `validate-hosted-dispatcher` on the dashboard carries the final state. This
  document deliberately does not claim "published" or "merged".

## Evidence index

- Build event log (durable, live): `https://autobuild.defrex.com` → build
  `validate-hosted-dispatcher` (API: `GET /builds/validate-hosted-dispatcher/events`)
- Repository journal (durable, live): `GET /repos/https%3A%2F%2Fgithub.com%2Fdefrex%2Fautobuild/events`
- Deposited build artifacts: `cutover-build-event-log`, `cutover-repository-journal`,
  `cutover-validation-report` (attached to the PR description at finalize)
- Dispatcher effective config: repository artifact kind
  `dispatcher-effective-config`, rev 50 as of 2026-09-11T19:54:50Z
- Branch: `ab/validate-hosted-dispatcher` → PR into `main` (auto-merge requested)
- Tickets: [AUT-320](https://linear.app/issue/AUT-320),
  [AUT-304](https://linear.app/issue/AUT-304) (evidence section appended to body)
