# RFC 0004 — Verify stages

**Status:** proposed, 2026-10-24; open questions settled by the maintainer
the same day (§11). Not decided design. `SPEC.md` describes the running
system until a ticket that builds a section of this RFC amends it.

**Hat:** product. The stage grammar, the kernel's stage execution, the new
events, the operator surfaces and the guidance ship to every user. Adopting
stages in this repository's own `autobuild.toml` is this repository's
configuration and is filed separately (§12, items 6 and 7).

## 1. Problem

Verification is one of the slowest parts of a build, and Autobuild runs it
one step at a time. `[verify].steps` is an ordered list. The engine runs the
first unsatisfied step, waits for its outcome, and only then decides the
next (`SPEC.md` §5, §15.6-A). Lint, type checking, the unit suite, a
database-backed integration suite and an acceptance agent therefore run in
series, even when none depends on another.

This costs two things.

- **Latency on the pass path.** A cycle takes the *sum* of its steps. Most
  steps are independent, so the floor could be the *longest* step instead.
- **Round trips on the failure path.** The first failure ends the cycle, so
  steps after it never run. Implement fixes the one failure it was told
  about, code review runs again, and the next cycle finds the failure that
  was waiting behind it. Each extra round trip costs an implement round, a
  code review and a full re-verify.

Autobuild's value is the safety its verification gives, so dropping or
weakening steps is not the answer. The answer is to run the same steps
sooner.

Measured in this repository (Evidence): verification is about a quarter of
build wall time, a build averages more than two verify cycles, and a failure
costs a median 14 minutes before the next cycle even starts.

## 2. Goal and summary

The goal: let a repository run independent verify steps at the same time
without weakening any gate. Each repository's operator agent decides what is
independent, guided by the installed `ab-guide`.

1. **Stages.** `[verify].steps` may group steps into *stages*. Every step in
   a stage starts together. The next stage starts only when every step in the
   current stage has passed or been skipped (§3, §4).
2. **Complete stage reports.** By default a stage *settles* (every member
   reaches an outcome) before a failure routes to implement, and implement
   receives every failed step's report at once (§4.3, §4.5).
3. **Opt-in fail-fast.** A step marked `failFast = true` cancels the rest of
   its stage when it fails, so one decisive failure is not held behind a long
   sibling (§4.4).
4. **Serial by default.** A plain string list means one step per stage, which
   is exactly today's behavior. No existing configuration changes meaning.
5. **A scratch directory per agent session.** `ab context` hydrates each
   session into its own directory under `.ab/`, so any number of agent
   verifiers can share a stage (§5).
6. **Guidance, not policy.** `ab-guide` teaches how to weigh pass-path latency
   against failure-path completeness (§8). The product does not guess which
   steps are independent.

## 3. Configuration

`steps` accepts a mix of step names and arrays of step names. A string is a
one-member stage; an array is a stage.

```toml
[verify]
steps = [
  ["lint", "types"],            # seconds: fail fast for the cheap checks
  ["unit", "integration"],      # independent suites, run together
  "acceptance",                 # the agent runs only on code that passes
]

[verify.integration]
kind = "check"
command = "test-integration"
failFast = false                # default: a failure waits for its stage
```

- TOML 1.0 permits mixed arrays, and the existing parser accepts them. Using
  `steps` avoids a new reserved key in `[verify]`, whose other keys are step
  names.
- Validation: no empty stage, no step in two stages, and every name still
  needs its `[verify.<step>]` table. Stage size is not capped: the
  configuration alone decides how much runs at once.
- Step names become directory names (§5), so verify and finalize step names
  must be path-safe: letters, digits, `.`, `_` and `-`, and never `.` or
  `..`. This tightens validation that today accepts any nonempty key.
- `failFast` is an optional boolean on any step table, defaulting to `false`.
  In a one-member stage it has no effect, because the stage settles when its
  only member does.
- Plan selection (`verifySteps`), `always`, `paths` and `afterReconcile` stay
  per step and keep their meanings (§4.1).
- `[verify]` stays build-owned and pinned (§16.1), so a build always runs the
  stage layout its own branch declares.

## 4. Kernel semantics

### 4.1 Stage entry

The engine finds the first stage with any member that is not satisfied in the
current cycle. It resolves every member's narrowing first, in the existing
order: post-reconcile policy, then plan selection, then path applicability
(§16.1). Members that resolve to `skipped` record their skip facts as today.
The remaining members start together.

Path applicability is evaluated at stage entry instead of immediately before
each step. Verification never changes the code, so `HEAD` is the same for
every member and the result is identical.

### 4.2 Running

The engine returns one stage decision carrying every member's action. The
build runner remains the single process for the build (§3.3). It starts every
member, appends each `verify.started`, and appends each outcome as it
arrives. The engine stays the only decider. Every append wakes it, and it
either waits for the stage, cancels the stage (§4.4) or routes once the stage
has settled.

All members of one cycle share one attempt number, as all steps do today.

### 4.3 Settling and the barrier

A stage has *settled* when every member that started has a terminal fact:
`pass`, `fail`, `skipped` or `cancelled`.

- Every member passed or skipped: the next stage starts, or finalize runs
  after the last stage.
- Any member failed: the cycle stops at the barrier and routes to implement
  (§4.5). Later stages do not run. This generalizes today's rule that a
  failure ends the cycle.

A skip still satisfies only its own step and never hides a sibling's failure.

### 4.4 Fail-fast

When a step with `failFast = true` fails, the kernel cancels every member of
its stage that has no terminal fact yet:

- A check's process group is terminated.
- An agent verifier's session is ended through the same termination path
  that pause and abort use.
- The kernel appends `verify.cancelled {step, attempt, cause: {step}}` for
  each cancelled member. The cause names the fail-fast step whose failure
  triggered the cancellation.

A member that reaches its own outcome first keeps it, and that fact stands.
After cancellation the terminal guard refuses any late `ab verdict` from a
cancelled verifier. The stage then has settled, and routing proceeds as in
§4.3.

Cancelled steps are neither passing evidence nor failures. They run again in
the next cycle with everything else, because a failed cycle reruns from the
first stage.

### 4.5 Feedback to implement

Verify feedback becomes a list:
`feedback: {verify: [{step, report}, ...]}`, one entry per failed step in the
settled stage. `ab context` materializes every report under `.ab/verify/` as
today. The manifest also lists the steps cancelled by fail-fast, so the
implementer knows which steps never finished and does not assume they passed.

Readers accept the historical single-object shape, so existing logs reduce
unchanged.

### 4.6 Escalation inside a stage

An agent verifier that runs `ab escalate` holds only its own step. Its
siblings run to completion, and the stage does not settle until the answer
arrives and the rerun of that step finishes. The answer reruns the same step
with guidance, exactly as today (§15.6-A).

This keeps escalation semantics unchanged. The cost is that sibling failures
wait on whoever answers, which is usually an operator agent rather than a
human. §11 records the decision.

### 4.7 Recovery and resumption

Resumption still comes from the log. On restart, the engine sees the open
stage: its members with `verify.started` and no terminal fact. Each one is
rerun at the same attempt under the existing per-step recovery rules
(§15.6-C), which apply to each member independently. Phase-failure budgets
(`maxPhaseAttempts`) stay keyed by `verify:<step>` and attempt.

### 4.8 Budgets

`policy.maxVerifyAttempts` still counts distinct failed cycles. A stage with
three failures is one failed cycle. Fewer cycles for the same set of
failures therefore stretches the budget further.

## 5. Shared workspace

Every member of a stage runs in the build's one workspace at the verified
head. That has two consequences.

- **Repository resources are the operator's concern.** Ports, databases,
  build output directories and CPU are specific to each repository. The
  product cannot know whether two of its steps collide, so stage authors
  decide, and §8 teaches what to check.
- **Agent scratch is the product's concern.** Today `ab context` hydrates one
  phase-scoped scratch directory, `.ab/` (§8.3). Two agent verifiers in the
  same workspace would overwrite each other's `context.json`, `spec.md` and
  guidance.

### 5.1 Session directories

Every agent session, in every phase, gets its own scratch directory under
`.ab/`, named after its phase:

```
.ab/
  plan/  plan-review/  implement/  code-review/  reconcile/  finalize/
  verify-<step>/        # one per agent verify step
  finalize-<step>/      # one per agent finalize step
```

Each directory holds what `.ab/` holds today: `context.json`, `spec.md`,
`assets/`, guidance, and the phase's other inputs. Implement's routed-back
failure reports move to `.ab/implement/verify/`. Nothing is hydrated at the
`.ab/` root any more.

- **One layout, always.** Serial and concurrent sessions use the same
  directories, so there is no second mode to test or to document.
- **No isolation.** Sessions can read each other's directories, which is
  harmless: they run against the same head and write their own outputs.
- **The CLI finds the directory itself.** The runner exports it to the
  session as `AB_CONTEXT_DIR`, and `ab context` prints it. CLI commands
  resolve the manifest from the session, never from a fixed path.
- **Hydration stays per phase.** A later round of the same phase re-hydrates
  its own directory, as `.ab/` is re-hydrated today.

The alternative was a linked worktree per agent verifier. It isolates
everything, but it pays the repository's setup command (dependency install,
provisioning) once per verifier per cycle, in every sandbox. That cost would
often exceed the latency saved.

### 5.2 Migration

Canonical skills move to the new paths in the same change. Repository-authored
skills are the cost: every repository has at least one, its acceptance check,
and these skills read inputs such as `.ab/spec.md` and `.ab/guidance.json` by
fixed path.

- Output files a skill writes at `.ab/` are unaffected. Only inputs move, and
  `ab verdict --report <path>` already takes an explicit path.
- `ab context` prints where every input landed. An agent following a stale
  path sees the correct location in the same command output.
- `ab-guide`'s skill-authoring guidance and setup reference teach
  `$AB_CONTEXT_DIR`. `docs/upgrading.md` and the release notes name the
  change and give a one-line fix for repository-authored skills.

## 6. Events and compatibility

- New: `verify.cancelled {step, attempt, cause: {step}}`. It records a fact,
  the cancellation, and derives nothing.
- Changed: `implement.started.feedback.verify` accepts a list. The old
  single object still validates.
- The reducer's `verify.currentStep` becomes the set of running steps. Every
  consumer of the single field moves to the set (§7).
- The `ab context` manifest gains its own directory. Session directories
  change no event.

A build whose pinned config uses stages must run on a runtime that
understands them. Config validation on an older runtime rejects a nested
`steps` array, and `verify.cancelled` is a decisive fact under the
version-tolerant read rules (AUT-866), so a mixed-version reader defers
instead of misreading.

## 7. Surfaces

- The shared dashboard projection reports every running verify step, not one
  current step. Both the terminal dashboard and the operator web app render
  that vocabulary, and the web app change extends the existing build row,
  following `DESIGN.md`. It adds no new surface.
- `ab status`, `ab watch` and the operator tools report the running set and
  any cancellations with their cause.
- Stage boundaries appear in the build timeline, so an operator can see
  which steps ran together.

## 8. Guidance for operators

`ab-guide` gains a section on stage layout. Its substance:

- **Run cheap checks in an early stage.** A step that takes seconds costs
  almost nothing when run alone first, and its failure arrives at once.
- **Put agent verifiers after the deterministic checks.** Agent runs cost
  money, and an agent testing code that does not build produces a
  misleading report.
- **Group steps whose failures are independent.** Two suites that fail for
  different reasons belong together, so one cycle reports both failures.
- **Do not group steps that share mutable resources** unless they are
  isolated: ports, databases, output directories, caches. If two steps
  cannot run together in a developer's terminal, they cannot run together
  here.
- **Watch CPU and capacity.** A test runner may already use every core, and
  each of the `capacity` concurrent builds runs its stages at once. Nothing
  caps stage size, so the stage layout is the whole concurrency budget.
- **Read inputs from `$AB_CONTEXT_DIR`** in repository-authored verifier
  skills, never from fixed `.ab/` paths.
- **Use `failFast` when a failure makes sibling results meaningless or
  misleading**, such as a build, codegen or migration failure. Hundreds of
  test failures caused by one compile error are noise to the implementer.
- **Use `failFast` when the failing step usually finishes long before its
  siblings.** Without it, every failure waits out the siblings' remaining
  time.
- **The trade-off in one line:** waiting costs P(this step fails) × the
  siblings' remaining time. It saves P(a sibling also fails independently) ×
  one round trip (implement, code review, re-verify).
- **Decide from history.** Steps that implementers already run before `done`
  rarely fail in verify, so their placement matters little. `ab` build
  history shows which steps actually fail and how long each takes.

## 9. What does not change

- The fixed grammar. `verify:*` stays one extension point. Stages are a
  grouping of its members, not a workflow engine, and arbitrary DAGs remain
  out of scope (§17).
- Step kinds, outcomes and skip rules, including the rule that a skip never
  hides a failure.
- A failed cycle reruns from the first stage, which is the first step for a
  serial configuration.
- Finalize, finalize steps and reconcile.
- Every configuration written before this RFC.

## 10. Alternatives considered

- **A dependency graph between steps.** It is more expressive, but harder to
  read and validate, and it conflicts with the fixed-grammar principle.
  Ordered stages cover the cases we know of.
- **A grace period instead of `failFast`.** On a failure, wait up to N
  minutes for siblings, then cancel. It adapts automatically, but the
  outcome then depends on timing and is harder to reason about. Revisit if
  per-step `failFast` proves too coarse.
- **Cancel on failure by default.** This keeps today's failure-path latency,
  but gives up the complete report, which is half the value. Authors who
  want early feedback for cheap checks get it from stage order.
- **Starting verify during code review.** Checks could begin when implement
  finishes and be kept if review approves the same head. Code review
  averages under three minutes here and asks for revisions about a third of
  the time, and the change moves the verify cycle boundary. The gain is
  small for a large kernel change.
- **Sharding inside a step.** Splitting a long suite is each repository's own
  command-level concern and is complementary: stages cannot make a cycle
  shorter than its longest step.

## 11. Decisions

Settled by the maintainer on 2026-10-24:

1. **An escalation blocks its stage (§4.6).** Escalation semantics stay as
   they are. An operator usually answers quickly, so sibling failures waiting
   on the answer is acceptable. The rejected alternative routed sibling
   failures to implement at once and superseded the open escalation.
2. **No concurrency cap.** The configuration decides how much runs at once.
   A repository that runs many steps in parallel is spending its own
   machine.
3. **Every agent session always gets its own scratch directory (§5.1),**
   named after its phase, with no isolation between them. This replaces a
   phased plan that first limited stages to one agent step.

## 12. Delivery plan

Filed after this repository's in-flight verify-step changes land on `main`,
so the children build against the current configuration:

1. **Session directories.** Per-phase scratch directories (§5.1),
   `AB_CONTEXT_DIR`, session-resolved manifests in the CLI, and path-safe
   step-name validation. Moves every canonical skill and `ab-guide` reference
   to the new paths. Amends `SPEC.md` §8.3, and covers the migration notes
   in §5.2.
2. **Reducer and events.** The running-step set, `verify.cancelled` and the
   list-shaped verify feedback, with readers that accept historical shapes.
3. **Stage execution.** The `steps` grammar and validation; stage entry,
   concurrent running, settling and routing in the engine and runner;
   multi-report materialization in `ab context`. Amends `SPEC.md` §5, §15.3,
   §15.5, §15.6-A and §16.1. Updates `docs/verification.md`,
   `docs/configuration.md`, the `ab-guide` configuration table and stage
   guidance (§8), and the `ab-implement` and `ab-finalize` passages that
   describe a single verify report.
4. **Fail-fast.** `failFast`, cancellation of checks and sessions, the late
   verdict guard, and the cancelled-steps manifest entry. Adds the `failFast`
   guidance to `ab-guide`.
5. **Surfaces.** The dashboard projection, terminal dashboard, web app row,
   `ab status`, `ab watch` and the operator tools.
6. **This repository's skill paths.** Repository-local skills read inputs
   from `${AB_CONTEXT_DIR:-.ab}`. Works before and after item 1.
7. **This repository's stages.** Group this repository's verify steps into
   stages, using the measurements in Evidence as the starting point.

Item 1 depends on 6, so this repository's own verifiers never meet the new
layout with stale paths, and each ticket keeps a single hat. Item 3 depends
on 1 and 2. Items 4 and 5 depend on 3. Item 7 depends on 3.

## Evidence

- Maintainer discussion, 2026-10-24 session: verification is "one of the
  slowest parts of the process"; the safety it brings is "a lot of the value"
  and must not drop; wasted compute matters less than pipeline latency;
  operator agents in each repository should "make the final call" on what
  can be parallelized.
- The same session raised the failure-path cost: a type error caught in
  seconds today could wait 30 minutes behind an integration suite. It chose
  a configurable wait-or-exit-early setting plus best-practice guidance, and
  this RFC builds that as stages plus `failFast`.
- Maintainer decisions, 2026-10-24 session: escalations may block, since
  "most of the time there's an operator who answers the escalations
  anyway"; no cap, "let the config determine how many to run in parallel
  ... it's their computer"; "always give each agent session its own scratch
  directory to keep it simple", named after the step, and "I don't think
  it's a problem if they can see each other's work."
- Measurements from this repository's local BuildStore, covering the 144
  builds that reached finalize from 2026-10-01 to 2026-10-24:
  - Verification took 24.3% of build wall time: 21.5 of 88.6 minutes on
    average, over 2.17 verify cycles per build.
  - With every step of a cycle run at once, the same cycles would have taken
    14.9 minutes. The unit suite (7.1 minutes average, 17 maximum) bounds
    it.
  - Failures recorded in verify: type checking 0, lint 4, the unit suite 34,
    the database-backed suite 16, agent verifiers 33. Cheap checks rarely
    fail in verify because implementers run them before `done`.
  - The median time from a verify failure to the next verify start is 14.0
    minutes. The mean is 92 minutes, inflated by escalation waits.
  - Code review averages 2.8 minutes on approval and 4.6 on revision; 106 of
    325 verdicts were revisions.
- `packages/core/src/kernel/engine.ts`: `decideNext` returns one verify action
  for the first unsatisfied step. `packages/core/src/kernel/reducer.ts`:
  `verify.currentStep` holds one step.
- `SPEC.md` §8.3: `ab context` hydrates one phase-scoped `.ab/` scratch
  directory.
