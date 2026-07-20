/**
 * The dashboard projection (src/cli/dashboard/model.ts) — the highest-value
 * seam here: pure, no terminal, and the place every correctness bug in this
 * feature has actually lived.
 *
 * Scenarios are hand-built event logs run through the REAL `reduceBuild`, not
 * hand-written `BuildState` literals: the projection's whole job is to agree
 * with the reducer and the engine, and a literal would let it agree with a
 * fiction instead.
 *
 * Every scenario also runs through two GENERIC guards (see `project`). Five
 * rounds of per-row auditing missed a defect every time — twice in rows a
 * reviewer had just cleared — so the guards, not the hand-written cases, are
 * the real defense. Guard B in particular asks the engine itself.
 */
import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { parseConfig } from '../../config/load'
import {
  validateEventWrite,
  allowedActorKinds,
  type AbEvent,
  type EventWrite,
} from '../../events/catalog'
import { KERNEL, humanActor, type Actor } from '../../events/envelope'
import { eventPayloadSchemas, type EventType } from '../../events/payloads'
import { decideNext } from '../../kernel/engine'
import { reduceBuild } from '../../kernel/reducer'
import type { Config } from '../../config/schema'
import type { Finding, Phase } from '../../ontology'
import { verifyPhase } from '../../ontology'
import { steppingClock } from '../../testing/fixed'
import { MemoryBuildStore } from '../../store/memory'
import type { BuildRecord } from '../../store/types'
import { buildDashboard, projectBuild, type DashboardBuild, type PipelineStep } from './model'

const BUILD = 'auth-rate-limit'

/** Default policy: maxVerifyAttempts 3, maxReviewRounds 4. `[finalize].steps`
 * defaults to `[]` — the DEFAULT config path, and the one the merge row's
 * vacuous-`every` window lives in. */
const CONFIG = parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[commands]
lint = "bun lint"
test = "bun test"

[verify]
steps = ["lint", "test"]

[verify.lint]
kind = "check"
command = "lint"

[verify.test]
kind = "check"
command = "test"
`)

/** Same, with a finalize post-step. */
const CONFIG_POST_STEPS = parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[commands]
lint = "bun lint"
test = "bun test"

[verify]
steps = ["lint", "test"]

[verify.lint]
kind = "check"
command = "lint"

[verify.test]
kind = "check"
command = "test"

[finalize]
steps = ["changelog"]
`)

// ── Fixture plumbing (reducer-test style: seq by index, every write validated)

type PayloadInput<T extends EventType> = z.input<(typeof eventPayloadSchemas)[T]>

function defaultActor(type: EventType): Actor {
  const kind = allowedActorKinds[type][0]
  switch (kind) {
    case 'kernel':
      return KERNEL
    case 'dispatcher':
      return { kind: 'dispatcher' }
    case 'human':
      return humanActor('aron')
    case 'agent':
      return { kind: 'agent', role: 'test-role', session: 's_test' }
    default:
      return { kind: 'ingester', source: 'test' }
  }
}

function ev<T extends EventType>(type: T, payload: PayloadInput<T>): EventWrite {
  return validateEventWrite({ actor: defaultActor(type), type, payload })
}

function toLog(writes: EventWrite[]): AbEvent[] {
  const clock = steppingClock()
  return writes.map(
    (write, index) =>
      ({
        build: BUILD,
        seq: index + 1,
        ts: clock().toISOString(),
        actor: write.actor,
        type: write.type,
        payload: write.payload,
      }) as AbEvent,
  )
}

const RECORD: BuildRecord = {
  slug: BUILD,
  repo: '/repos/app',
  ticket: { source: 'linear', id: 'ENG-42', title: 'Auth rate limiting' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function finding(id: string): Finding {
  return { id, severity: 'blocking', summary: `finding ${id}`, persists: [] }
}

// ── Fixture segments ─────────────────────────────────────────────────────────

function prelude(): EventWrite[] {
  return [
    ev('build.created', {
      ticket: { source: 'linear', id: 'ENG-42', title: 'Auth rate limiting' },
      repo: '/repos/app',
      baseBranch: 'main',
    }),
    ev('workspace.provisioned', {
      provider: 'worktree',
      ref: '/ws/auth-rate-limit',
      branch: 'ab/auth-rate-limit',
      base: { source: 'remote', sha: 'base-sha' },
    }),
    ev('spec.imported', {
      artifact: { kind: 'spec', rev: 0 },
      ticket: { source: 'linear', id: 'ENG-42' },
    }),
    ev('runner.attached', { instance: 'runner-1', host: 'local' }),
  ]
}

function planRound(round: number, verdict: 'approve' | 'revise'): EventWrite[] {
  return [
    ev('plan.started', { round }),
    ev('plan.completed', { round, artifact: { kind: 'plan', rev: round - 1 } }),
    ev('plan-review.started', { round }),
    ev('plan-review.verdict', {
      round,
      verdict,
      findings: verdict === 'revise' ? [finding(`f_p${round}`)] : [],
      artifact: { kind: 'plan-review', rev: round - 1 },
    }),
  ]
}

function codeRound(round: number, verdict: 'approve' | 'revise'): EventWrite[] {
  return [
    ev('implement.started', { round }),
    ev('implement.completed', {
      round,
      commits: { base: 'sha-base', head: `sha-r${round}` },
      artifact: { kind: 'implement-notes', rev: round - 1 },
    }),
    ev('code-review.started', { round }),
    ev('code-review.verdict', {
      round,
      verdict,
      findings: verdict === 'revise' ? [finding(`f_c${round}`)] : [],
      artifact: { kind: 'code-review', rev: round - 1 },
    }),
  ]
}

function verifyRun(step: string, attempt: number, pass: boolean): EventWrite[] {
  return [
    ev('verify.started', { step, attempt }),
    ev('verify.completed', {
      step,
      attempt,
      pass,
      ...(pass ? {} : { report: { kind: `verify-report:${step}`, rev: 0 } }),
    }),
  ]
}

function verifySkip(step: string, attempt: number, reason: string): EventWrite[] {
  return [
    ev('verify.started', { step, attempt }),
    ev('verify.completed', { step, attempt, outcome: 'skipped', reason }),
  ]
}

function finalized(): EventWrite[] {
  return [
    ev('finalize.started', {}),
    ev('finalize.completed', {
      pr: { number: 7, url: 'https://github.com/defrex/app/pull/7', headSha: 'sha-r1' },
    }),
  ]
}

function reviseSpec(escalationSeq: number, phase: Phase): EventWrite[] {
  return [
    ev('escalation.raised', {
      id: 'e_respec',
      phase,
      source: 'policy',
      question: 'the spec does not say what to do here',
    }),
    ev('escalation.answered', {
      id: 'e_respec',
      answer: 'rewriting the spec',
      resolution: 'revise-spec',
    }),
    ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: escalationSeq }),
  ]
}

/** The happy path up to (and including) the code-review approve at round 1. */
function throughCodeReview(): EventWrite[] {
  return [...prelude(), ...planRound(1, 'approve'), ...codeRound(1, 'approve')]
}

// ── The projection under the guards ──────────────────────────────────────────

function stepFor(build: DashboardBuild, label: string): PipelineStep | undefined {
  return build.steps.find((s) => s.label === label)
}

function stateOf(build: DashboardBuild, label: string): PipelineStep['state'] | undefined {
  return stepFor(build, label)?.state
}

/**
 * Project a log AND run the generic guards over the result. Every scenario in
 * this file goes through here — that is the point of the guards.
 */
function project(log: AbEvent[], config: Config = CONFIG): DashboardBuild {
  const build = projectBuild(RECORD, reduceBuild(log), config, log)
  if (build === null) throw new Error('projectBuild returned null — the build is not active')
  guardA(log, build)
  guardB(log, build, config)
  return build
}

/**
 * **Guard A — no `done` after an unsettled step**, plus at most one `current`.
 * Both `pending` and `provisional` are unsettled: the latter proves output was
 * produced, not that the engine has stopped re-running the step.
 *
 * Skipped once the build has reconciled: §15.7 deliberately loops verify back
 * BEHIND a completed finalize, so `verify:test [ ] … finalize [x]` is correct
 * there and the linear reading no longer holds. The exclusion keys off a
 * `reconcile.completed` in the LOG rather than off the finalize row, so a
 * buggy row can never switch its own guard off — which matters, because
 * `finalize [x]` sitting after a pending plan is exactly the defect
 * `f_03d0f6d4` was. (Without a reconcile, verify can only be pending while
 * finalize is done if a restart happened, and a restart un-does finalize too.)
 */
function guardA(log: AbEvent[], build: DashboardBuild): void {
  const currents = build.steps.filter((s) => s.state === 'current')
  expect(currents.length).toBeLessThanOrEqual(1)

  if (log.some((e) => e.type === 'reconcile.completed')) return
  // `merge` is never done and sits past the epilogue rows; the core pipeline is
  // what must read linearly.
  const core = build.steps.filter((s) => s.label !== 'merge' && s.label !== 'reconcile')
  const firstUnsettled = core.findIndex((s) => s.state !== 'done')
  if (firstUnsettled === -1) return
  expect(core.slice(firstUnsettled).filter((s) => s.state === 'done')).toEqual([])
}

/**
 * **Guard B — the engine oracle.** The plan-wide semantic (*a step is `done`
 * iff the engine will not re-run it*) made executable: ask `decideNext` what
 * runs next and assert that step is not rendered `done`.
 *
 * This is the guard that compares against the engine itself rather than
 * against a shape a row happens to have, which is why it catches the defects
 * shape-based guards structurally cannot (`f_9ce5ba8d`'s row is
 * `implement [x] code-review [x] verify [ ]` — every done precedes every
 * pending, so no ordering guard can see it).
 *
 * It has **two halves**, because `done` was never the only predicate that can
 * disagree with the engine — `f_7edf2816` was a `current` that did:
 *
 *   B1. the step the engine names is not `done`.
 *   B2. if a row is `current`, the engine names THAT phase.
 *
 * B2 is the sound direction only. The converse — "the named phase IS current"
 * — is **not** an invariant and must not be asserted: `run-phase plan` is also
 * the answer when plan is merely DUE, and the plan documents intentional
 * zero-current windows (see the test below). B2 rests on §15.6-C instead: a
 * started-without-terminal phase is exactly what the engine re-runs FROM ITS
 * START, so if something is genuinely running, `decideNext` names it. A
 * non-run decision (wait / acknowledge / raise-escalation) names no phase and
 * is exempt.
 *
 * **Known blind spot:** a `wait` decision names no phase — and that covers the
 * two durable, human-paced states an operator stares hardest at (blocked on an
 * escalation; awaiting a spec revision). Those get explicit hand-written cases
 * below. Do NOT read a green Guard B as covering them.
 */
function guardB(log: AbEvent[], build: DashboardBuild, config: Config): void {
  const decision = decideNext(log, config)
  const notDone = (label: string): void => {
    const step = stepFor(build, label)
    expect(step).toBeDefined()
    expect(step?.state).not.toBe('done')
  }

  // B1 — the engine's next step is not already ticked.
  switch (decision.kind) {
    case 'run-phase':
      notDone(decision.phase)
      break
    case 'run-check':
    case 'run-agent-verify':
    case 'evaluate-verify':
      notDone(verifyPhase(decision.step))
      break
    case 'run-finalize-step':
      notDone(decision.step)
      break
    default:
      break
  }

  // B2 — nothing else claims to be running. `merge` is exempt: it is not a
  // phase, and when it is current the engine is parked on `wait{awaiting-pr}`,
  // which this switch already skips.
  const named =
    decision.kind === 'run-phase'
      ? decision.phase
      : decision.kind === 'run-check' ||
          decision.kind === 'run-agent-verify' ||
          decision.kind === 'evaluate-verify'
        ? verifyPhase(decision.step)
        : undefined
  if (named === undefined) return
  const current = build.steps.find((s) => s.state === 'current')
  if (current === undefined) return
  expect(current.label).toBe(named)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('projectBuild: the active-build filter', () => {
  test('queued, done and aborted are excluded; running/paused/blocked are listed', () => {
    const queued = toLog(prelude().slice(0, 3)) // no runner.attached
    expect(projectBuild(RECORD, reduceBuild(queued), CONFIG, queued)).toBeNull()

    const running = toLog(prelude())
    expect(projectBuild(RECORD, reduceBuild(running), CONFIG, running)).not.toBeNull()

    const done = toLog([...prelude(), ev('build.completed', { outcome: 'merged' })])
    expect(projectBuild(RECORD, reduceBuild(done), CONFIG, done)).toBeNull()

    const aborted = toLog([...prelude(), ev('build.aborted', {})])
    expect(projectBuild(RECORD, reduceBuild(aborted), CONFIG, aborted)).toBeNull()

    const paused = toLog([...prelude(), ev('build.paused', {})])
    expect(projectBuild(RECORD, reduceBuild(paused), CONFIG, paused)?.status).toBe('paused')
  })

  test('buildDashboard drops nulls and sorts by slug for a stable frame', () => {
    const activeLog = toLog(prelude())
    const goneLog = toLog([...prelude(), ev('build.completed', { outcome: 'merged' })])
    const active = reduceBuild(activeLog)
    const gone = reduceBuild(goneLog)
    const model = buildDashboard(
      [
        { record: { ...RECORD, slug: 'zebra' }, state: active, events: activeLog },
        { record: { ...RECORD, slug: 'gone' }, state: gone, events: goneLog },
        { record: { ...RECORD, slug: 'alpha' }, state: active, events: activeLog },
      ],
      CONFIG,
      { repo: '/repos/app', capacity: 2 },
    )
    expect(model.builds.map((b) => b.slug)).toEqual(['alpha', 'zebra'])
    expect(model).toMatchObject({
      repo: '/repos/app',
      capacity: 2,
      drained: false,
      defaultAutoMerge: false,
      harvestPaused: false,
      statusLine: '',
    })
    expect('mode' in model).toBe(false)
    const settings = buildDashboard(
      [],
      CONFIG,
      { repo: '/repos/app', capacity: 2 },
      [
        {
          repo: '/repos/app',
          seq: 1,
          ts: '2026-07-20T00:00:00.000Z',
          actor: humanActor('operator'),
          type: 'dispatcher.intake-set',
          payload: { enabled: false },
        },
        {
          repo: '/repos/app',
          seq: 2,
          ts: '2026-07-20T00:00:01.000Z',
          actor: humanActor('operator'),
          type: 'dispatcher.auto-merge-default-set',
          payload: { enabled: true },
        },
      ],
    )
    expect(settings.drained).toBe(true)
    expect(settings.defaultAutoMerge).toBe(true)
  })

  test('the header gate follows acknowledgements, not pending commands or a synthetic row', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repos/app')
    await store.appendRepo('/repos/app', {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
    })
    let model = buildDashboard(
      [],
      CONFIG,
      { repo: '/repos/app', capacity: 2 },
      await store.getRepoEvents('/repos/app'),
    )
    expect(model.harvestPaused).toBe(false)
    expect(model.harvest).toBeUndefined()

    await store.appendRepo('/repos/app', {
      actor: KERNEL,
      type: 'harvest.paused',
      payload: {},
    })
    model = buildDashboard(
      [],
      CONFIG,
      { repo: '/repos/app', capacity: 2 },
      await store.getRepoEvents('/repos/app'),
    )
    expect(model.harvestPaused).toBe(true)
    expect(model.harvest).toBeUndefined()

    await store.appendRepo('/repos/app', {
      actor: humanActor('other-operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    model = buildDashboard(
      [],
      CONFIG,
      { repo: '/repos/app', capacity: 2 },
      await store.getRepoEvents('/repos/app'),
    )
    expect(model.harvestPaused).toBe(true)

    await store.appendRepo('/repos/app', {
      actor: KERNEL,
      type: 'harvest.resumed',
      payload: {},
    })
    model = buildDashboard(
      [],
      CONFIG,
      { repo: '/repos/app', capacity: 2 },
      await store.getRepoEvents('/repos/app'),
    )
    expect(model.harvestPaused).toBe(false)
  })
})

describe('projectBuild: native auto-merge display state', () => {
  test('distinguishes off, requested, enabled, and pending cancellation', () => {
    const off = toLog(prelude())
    expect(project(off).autoMerge).toBe('off')

    const requested = toLog([
      ...prelude(),
      ev('build.auto-merge-requested', {}), // seq 5
    ])
    expect(project(requested).autoMerge).toBe('requested')

    const enabled = toLog([
      ...prelude(),
      ev('build.auto-merge-requested', {}), // seq 5
      ev('pr.auto-merge-enabled', { commandSeq: 5 }),
    ])
    expect(project(enabled).autoMerge).toBe('enabled')

    const clearedBeforePr = toLog([
      ...prelude(),
      ev('build.auto-merge-requested', {}),
      ev('build.auto-merge-cancelled', {}),
    ])
    expect(project(clearedBeforePr).autoMerge).toBe('off')

    const cancelling = toLog([
      ...prelude(),
      ev('finalize.completed', {
        pr: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: 'head' },
      }), // seq 5
      ev('build.auto-merge-requested', {}), // seq 6
      ev('pr.auto-merge-enabled', { commandSeq: 6 }),
      ev('build.auto-merge-cancelled', {}), // seq 8
    ])
    expect(projectBuild(RECORD, reduceBuild(cancelling), CONFIG, cancelling)?.autoMerge).toBe(
      'cancelling',
    )

    const disabled = toLog([
      ...prelude(),
      ev('finalize.completed', {
        pr: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: 'head' },
      }),
      ev('build.auto-merge-requested', {}),
      ev('pr.auto-merge-enabled', { commandSeq: 6 }),
      ev('build.auto-merge-cancelled', {}),
      ev('pr.auto-merge-disabled', { commandSeq: 8 }),
    ])
    expect(projectBuild(RECORD, reduceBuild(disabled), CONFIG, disabled)?.autoMerge).toBe(
      'off',
    )
  })
})

describe('projectBuild: effective status (a DISPLAY rule, not a lifecycle one)', () => {
  const blockedAndPaused = toLog([
    ...prelude(),
    ev('plan.started', { round: 1 }),
    ev('escalation.raised', {
      id: 'e_1',
      phase: 'plan',
      round: 1,
      source: 'agent',
      question: 'which rate limit algorithm?',
    }),
    ev('build.paused', {}),
  ])

  test('open escalation + build.paused ⇒ blocked, with the pause still visible', () => {
    const build = project(blockedAndPaused)
    expect(build.status).toBe('blocked')
    expect(build.alsoPaused).toBe(true)
    expect(build.blockers).toEqual(['which rate limit algorithm?'])
  })

  test('…and the LIFECYCLE is untouched — the reducer still says paused', () => {
    // §15.5's precedence (paused > blocked) is deliberate: pausing is the
    // operator's explicit instruction. The spec asks for the opposite
    // VISUALLY, and "changing lifecycle semantics" is out of scope — so the
    // override lives in the display and this assertion pins that it stayed
    // there. `decideNext` must still park a paused+blocked build on `paused`.
    expect(reduceBuild(blockedAndPaused).status).toBe('paused')
    expect(decideNext(blockedAndPaused, CONFIG)).toEqual({ kind: 'wait', reason: 'paused' })
  })

  test('paused alone stays paused; blocked alone stays blocked', () => {
    const paused = project(toLog([...prelude(), ev('build.paused', {})]))
    expect(paused.status).toBe('paused')
    expect(paused.alsoPaused).toBe(false)

    const blocked = project(
      toLog([
        ...prelude(),
        ev('plan.started', { round: 1 }),
        ev('escalation.raised', {
          id: 'e_1',
          phase: 'plan',
          round: 1,
          source: 'agent',
          question: 'which algorithm?',
        }),
      ]),
    )
    expect(blocked.status).toBe('blocked')
    expect(blocked.alsoPaused).toBe(false)
  })
})

describe('projectBuild: blockers', () => {
  test('every unresolved blocker shows; an answered one does not', () => {
    const build = project(
      toLog([
        ...prelude(),
        ev('plan.started', { round: 1 }),
        ev('escalation.raised', {
          id: 'e_1',
          phase: 'plan',
          round: 1,
          source: 'agent',
          question: 'first question',
        }),
        ev('escalation.raised', {
          id: 'e_2',
          phase: 'plan',
          round: 1,
          source: 'agent',
          question: 'second question',
        }),
        ev('escalation.answered', { id: 'e_1', answer: 'do it this way', resolution: 'guidance' }),
        ev('escalation.raised', {
          id: 'e_3',
          phase: 'plan',
          round: 1,
          source: 'agent',
          question: 'third question',
        }),
      ]),
    )
    expect(build.blockers).toEqual(['second question', 'third question'])
  })
})

describe('projectBuild: the plan loop', () => {
  test('a fresh build is all pending, with plan current', () => {
    const build = project(toLog([...prelude(), ev('plan.started', { round: 1 })]))
    expect(stateOf(build, 'plan')).toBe('current')
    expect(stateOf(build, 'plan-review')).toBe('pending')
    expect(build.steps.filter((s) => s.state === 'done')).toEqual([])
    expect(build.ticketId).toBe('ENG-42')
  })

  test('a completed producer is provisional while its reviewer is current', () => {
    const build = project(
      toLog([
        ...prelude(),
        ev('plan.started', { round: 1 }),
        ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
        ev('plan-review.started', { round: 1 }),
      ]),
    )
    expect(stateOf(build, 'plan')).toBe('provisional')
    expect(stateOf(build, 'plan-review')).toBe('current')
  })

  test('a revise verdict leaves both current-round outputs provisional', () => {
    const build = project(toLog([...prelude(), ...planRound(1, 'revise')]))
    expect(stateOf(build, 'plan')).toBe('provisional')
    expect(stateOf(build, 'plan-review')).toBe('provisional')
  })

  test('the next producer round drops prior-round output and carries round 2', () => {
    const build = project(
      toLog([...prelude(), ...planRound(1, 'revise'), ev('plan.started', { round: 2 })]),
    )
    expect(stateOf(build, 'plan')).toBe('current')
    expect(stateOf(build, 'plan-review')).toBe('pending')
    expect(stepFor(build, 'plan')?.count).toBe(2)
    expect(stepFor(build, 'plan-review')?.count).toBe(2)
  })

  test('the zero-current window between plan.completed r2 and plan-review.started r2 is INTENTIONAL', () => {
    // The producer has output, but the pair is not durably settled until
    // approved and no phase is running. Do not patch this into a phantom
    // `current`; `provisional` is the display-only distinction.
    const build = project(
      toLog([
        ...prelude(),
        ...planRound(1, 'revise'),
        ev('plan.started', { round: 2 }),
        ev('plan.completed', { round: 2, artifact: { kind: 'plan', rev: 1 } }),
      ]),
    )
    expect(stateOf(build, 'plan')).toBe('provisional')
    expect(stateOf(build, 'plan-review')).toBe('pending')
    expect(build.steps.filter((s) => s.state === 'current')).toEqual([])
  })

  test('approval keeps both rows durably done', () => {
    const build = project(toLog([...prelude(), ...planRound(1, 'approve')]))
    expect(stateOf(build, 'plan')).toBe('done')
    expect(stateOf(build, 'plan-review')).toBe('done')
  })
})

describe('projectBuild: provisional code-loop output', () => {
  test('a completed implement is provisional while code-review is current', () => {
    const build = project(
      toLog([
        ...prelude(),
        ...planRound(1, 'approve'),
        ev('implement.started', { round: 1 }),
        ev('implement.completed', {
          round: 1,
          commits: { base: 'sha-base', head: 'sha-r1' },
          artifact: { kind: 'implement-notes', rev: 0 },
        }),
        ev('code-review.started', { round: 1 }),
      ]),
    )
    expect(stateOf(build, 'implement')).toBe('provisional')
    expect(stateOf(build, 'code-review')).toBe('current')
  })

  test('a revise verdict leaves both current-round outputs provisional', () => {
    const build = project(
      toLog([...prelude(), ...planRound(1, 'approve'), ...codeRound(1, 'revise')]),
    )
    expect(stateOf(build, 'implement')).toBe('provisional')
    expect(stateOf(build, 'code-review')).toBe('provisional')
  })

  test('current wins over a matching provisional output fact', () => {
    // A repeated start is the smallest validated raw-log fixture that makes
    // both facts true at once. Bypass the engine-oracle wrapper: this case
    // pins the projection helper's precedence, not a legal engine transition.
    const log = toLog([
      ...prelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      ev('plan.started', { round: 1 }),
    ])
    const build = projectBuild(RECORD, reduceBuild(log), CONFIG, log)
    expect(build).not.toBeNull()
    expect(stateOf(build!, 'plan')).toBe('current')
  })
})

// ── The regression suite: seven found instances, one per row ──────────────────
//
// Each names the finding that caught it. The shape is always the same: a
// reducer fact says "approved/passed/opened", the engine has since moved a
// boundary that invalidates it, and the row renders `done` for work that is
// about to re-run.

describe('f_9ce5ba8d: a verify failure reopens the code loop THE MOMENT it lands', () => {
  // Plan@3 identified this and closed it with `approval.round === implement.round`
  // — a clause that only engages once `implement.started` at the new round
  // lands. This asserts at the state that exposes the gap, NOT after it.
  const failedCycle = toLog([
    ...throughCodeReview(),
    ...verifyRun('lint', 1, true),
    ...verifyRun('test', 1, false),
  ])

  test('implement and code-review are NOT done before any implement.started r2', () => {
    const build = project(failedCycle)
    expect(stateOf(build, 'implement')).toBe('provisional')
    expect(stateOf(build, 'code-review')).toBe('provisional')
    // The engine has ALREADY decided to rewrite the code…
    expect(decideNext(failedCycle, CONFIG)).toMatchObject({
      kind: 'run-phase',
      phase: 'implement',
      round: 2,
    })
    // …while the reducer's full-log booleans still read approved. That gap is
    // the whole defect: `codeReviewApproved` is not a progress indicator.
    expect(reduceBuild(failedCycle).codeReviewApproved).toBe(true)
    expect(reduceBuild(failedCycle).implement.round).toBe(1)
  })

  test('…and still not done once implement.started r2 lands', () => {
    const build = project(toLog([...failedCycleWrites(), ev('implement.started', { round: 2 })]))
    expect(stateOf(build, 'implement')).toBe('current')
    expect(stateOf(build, 'code-review')).toBe('pending')
  })

  test('planDone does NOT over-fire: a verify failure reopens only the CODE loop', () => {
    // engine.ts:347-355 routes to implement, never plan — so `&& !cycleFailed`
    // must not leak into planDone.
    const build = project(failedCycle)
    expect(stateOf(build, 'plan')).toBe('done')
    expect(stateOf(build, 'plan-review')).toBe('done')
  })

  test('the DURABLE variant: policy exhausted ⇒ blocked, and Guard B is blind here', () => {
    // maxVerifyAttempts exhausted ⇒ the engine raises a policy escalation and
    // rule 3 parks the build `blocked`. No `implement.started` EVER lands until
    // a human answers, so plan@4's round clause never engages — this is the
    // state that persists, in red, with the blocker text, on the exact screen
    // this feature exists to provide.
    const config = parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[commands]
lint = "bun lint"
test = "bun test"

[verify]
steps = ["lint", "test"]

[verify.lint]
kind = "check"
command = "lint"

[verify.test]
kind = "check"
command = "test"

[policy]
maxVerifyAttempts = 1
`)
    const log = toLog([
      ...failedCycleWrites(),
      ev('escalation.raised', {
        id: 'e_policy',
        phase: 'verify:test',
        source: 'policy',
        question: 'maxVerifyAttempts (1) exhausted: verify:test is still failing',
      }),
    ])
    // Guard B cannot see this state — decideNext names no phase.
    expect(decideNext(log, config)).toEqual({ kind: 'wait', reason: 'blocked' })

    const build = project(log, config)
    expect(build.status).toBe('blocked')
    expect(build.blockers).toEqual([
      'maxVerifyAttempts (1) exhausted: verify:test is still failing',
    ])
    expect(stateOf(build, 'implement')).toBe('provisional')
    expect(stateOf(build, 'code-review')).toBe('provisional')
  })
})

function failedCycleWrites(): EventWrite[] {
  return [...throughCodeReview(), ...verifyRun('lint', 1, true), ...verifyRun('test', 1, false)]
}

describe('f_23e76d34: the verify cycle boundary', () => {
  test('mid-window — an earlier PASS in a failed cycle is not done', () => {
    const build = project(toLog(failedCycleWrites()))
    expect(stateOf(build, 'verify:lint')).toBe('provisional')
    expect(stepFor(build, 'verify:lint')?.qualifier).toBeUndefined()
    // The failing step keeps the information without claiming to be settled.
    expect(stateOf(build, 'verify:test')).toBe('provisional')
    expect(stepFor(build, 'verify:test')?.qualifier).toBe('failed')
  })

  test('post-approve — the boundary moved, so attempt 1 stops reading as done', () => {
    const log = toLog([...failedCycleWrites(), ...codeRound(2, 'approve')])
    const build = project(log)
    expect(stateOf(build, 'verify:lint')).toBe('pending')
    expect(stateOf(build, 'verify:test')).toBe('pending')
    // The code loop IS settled again — `&& !cycleFailed` must not over-fire.
    expect(stateOf(build, 'implement')).toBe('done')
    expect(stateOf(build, 'code-review')).toBe('done')
    expect(decideNext(log, CONFIG)).toMatchObject({ kind: 'run-check', step: 'lint', attempt: 2 })
  })

  test('a passing step in the CURRENT cycle is done', () => {
    const build = project(toLog([...throughCodeReview(), ...verifyRun('lint', 1, true)]))
    expect(stateOf(build, 'verify:lint')).toBe('done')
    expect(stateOf(build, 'verify:test')).toBe('pending')
  })

  test('a skipped step is satisfied but remains textually distinct from a pass', () => {
    const log = toLog([
      ...throughCodeReview(),
      ...verifySkip('lint', 1, 'No lintable files changed'),
    ])
    const build = project(log)

    expect(stateOf(build, 'verify:lint')).toBe('done')
    expect(stepFor(build, 'verify:lint')?.qualifier).toBe('skipped')
    expect(stateOf(build, 'verify:test')).toBe('pending')
    expect(decideNext(log, CONFIG)).toMatchObject({ kind: 'run-check', step: 'test' })
  })

  test('another step failure makes an earlier skip provisional without hiding its outcome', () => {
    const build = project(
      toLog([
        ...throughCodeReview(),
        ...verifySkip('lint', 1, 'No lintable files changed'),
        ...verifyRun('test', 1, false),
      ]),
    )

    expect(stateOf(build, 'verify:lint')).toBe('provisional')
    expect(stepFor(build, 'verify:lint')?.qualifier).toBe('skipped')
    expect(stateOf(build, 'verify:test')).toBe('provisional')
    expect(stepFor(build, 'verify:test')?.qualifier).toBe('failed')
  })
})

describe('f_89defd3e: the attempt count names the attempt ACTUALLY running', () => {
  const postApprove = [...failedCycleWrites(), ...codeRound(2, 'approve')]

  test('no attempt count on the verify steps after a boundary move, before the fresh cycle starts', () => {
    // `verify.maxAttemptSeen` is still 1 here and names the PREVIOUS cycle;
    // the current cycle is empty, so the verify steps carry no count or
    // completed state.
    const build = project(toLog(postApprove))
    expect(reduceBuild(toLog(postApprove)).verify.maxAttemptSeen).toBe(1)
    expect(stepFor(build, 'verify:lint')?.count).toBeUndefined()
    expect(stepFor(build, 'verify:test')?.count).toBeUndefined()
  })

  test('count 2 appears on the running step once verify.started a2 lands', () => {
    const build = project(toLog([...postApprove, ev('verify.started', { step: 'lint', attempt: 2 })]))
    expect(stateOf(build, 'verify:lint')).toBe('current')
    expect(stepFor(build, 'verify:lint')?.count).toBe(2)
    // …and only on the running step.
    expect(stepFor(build, 'verify:test')?.count).toBeUndefined()
  })
})

describe('f_fe651adc: a spec restart re-runs both loops', () => {
  const restarted = [
    ...prelude(),
    ...planRound(1, 'approve'),
    ...codeRound(1, 'approve'),
    ...reviseSpec(13, 'code-review'),
  ]

  test('no loop step is done after spec.revised, before any post-restart plan.started', () => {
    const build = project(toLog(restarted))
    expect(stateOf(build, 'plan')).toBe('pending')
    expect(stateOf(build, 'plan-review')).toBe('pending')
    expect(stateOf(build, 'implement')).toBe('pending')
    expect(stateOf(build, 'code-review')).toBe('pending')
    // The full-log booleans still read approved — that is exactly why the row
    // may not be built from them.
    const state = reduceBuild(toLog(restarted))
    expect(state.plan.approved).toBe(true)
    expect(state.codeReviewApproved).toBe(true)
    expect(decideNext(toLog(restarted), CONFIG)).toMatchObject({ kind: 'run-phase', phase: 'plan' })
  })

  test('…and again after plan.started r2', () => {
    const build = project(toLog([...restarted, ev('plan.started', { round: 2 })]))
    expect(stateOf(build, 'plan')).toBe('current')
    expect(stateOf(build, 'plan-review')).toBe('pending')
    expect(stateOf(build, 'implement')).toBe('pending')
    expect(stateOf(build, 'code-review')).toBe('pending')
  })
})

describe('f_03d0f6d4: finalize across a spec restart', () => {
  const restartedAfterPr = [
    ...throughCodeReview(),
    ...verifyRun('lint', 1, true),
    ...verifyRun('test', 1, true),
    ...finalized(),
    ...reviseSpec(19, 'finalize'),
  ]

  test('finalize is NOT done after the restart, though prState never moved', () => {
    const log = toLog(restartedAfterPr)
    const build = project(log)
    expect(stateOf(build, 'finalize')).toBe('pending')
    // The row must be right WITHOUT the underlying fact having moved: prState
    // is read by the janitor and the restart-orthogonal epilogue, so the fix
    // had to be additive.
    expect(reduceBuild(log).prState).toBe('open')
    expect(decideNext(log, CONFIG)).toMatchObject({ kind: 'run-phase', phase: 'plan' })
  })

  test('…and still not done after plan.started r2', () => {
    const build = project(toLog([...restartedAfterPr, ev('plan.started', { round: 2 })]))
    expect(stateOf(build, 'finalize')).toBe('pending')
  })

  test('merge is not current in the post-restart rebuild window (DEFAULT config)', () => {
    // Instance #6: after the rebuild re-passes verify and before
    // finalize.started, `verifyDrained` is true again, `currentPhase` is
    // undefined (the terminal event cleared it), `prState` is the STALE 'open'
    // from the old PR, and `postStepsDrained` is VACUOUSLY true because
    // [finalize].steps defaults to []. All four hold at once — only
    // `finalizeDone` keeps `merge [>] waiting` off the screen.
    const log = toLog([
      ...restartedAfterPr,
      ...planRound(2, 'approve'),
      ...codeRound(2, 'approve'),
      ...verifyRun('lint', 2, true),
      ...verifyRun('test', 2, true),
    ])
    const state = reduceBuild(log)
    expect(state.prState).toBe('open') // stale
    expect(state.currentPhase).toBeUndefined()
    expect(CONFIG.finalize.steps).toEqual([]) // the vacuous-every path

    const build = project(log)
    expect(stateOf(build, 'merge')).toBe('pending')
    expect(stateOf(build, 'finalize')).toBe('pending')
    expect(decideNext(log, CONFIG)).toMatchObject({ kind: 'run-phase', phase: 'finalize' })
  })
})

describe('an unlanded revise-spec answer parks the WHOLE pipeline (instance #8)', () => {
  // Found re-deriving the step table against engine.ts, as the plan's Risks
  // section instructed. engine.ts:221-227 parks on `wait{awaiting-spec}` until
  // the human lands rev N+1 — a HUMAN-paced window, so it is durable, and
  // every step behind it is about to re-run. `restartSince` has not moved yet,
  // so without the pending-restart boundary the dashboard renders
  // `finalize [x] merge [>] waiting` for work that is about to be thrown away.
  // Guard B is blind here (a `wait` decision names no phase), so this is
  // asserted by hand.
  const answered = [
    ...throughCodeReview(),
    ...verifyRun('lint', 1, true),
    ...verifyRun('test', 1, true),
    ...finalized(),
    ...reviseSpec(19, 'finalize').slice(0, 2), // raised + answered, NO spec.revised
  ]

  test('the engine is parked awaiting the spec, and nothing reads done', () => {
    const log = toLog(answered)
    expect(decideNext(log, CONFIG)).toEqual({ kind: 'wait', reason: 'awaiting-spec' })
    expect(reduceBuild(log).restartSince).toBe(0) // the boundary has NOT moved

    const build = project(log)
    expect(build.steps.filter((s) => s.state === 'done')).toEqual([])
    // The effective restart boundary suppresses old terminal outputs too.
    expect(build.steps.filter((s) => s.state === 'provisional')).toEqual([])
    expect(stateOf(build, 'merge')).toBe('pending')
    expect(stateOf(build, 'finalize')).toBe('pending')
  })

  test('the finalize post-steps re-run too, so they do not read done either', () => {
    const log = toLog([
      ...throughCodeReview(),
      ...verifyRun('lint', 1, true),
      ...verifyRun('test', 1, true),
      ...finalized(),
      ev('finalize.step-completed', { step: 'changelog', ok: true }),
      ...reviseSpec(20, 'finalize').slice(0, 2),
    ])
    const build = project(log, CONFIG_POST_STEPS)
    expect(stateOf(build, 'changelog')).toBe('pending')
  })

  test('a revise-spec answer BEFORE the last restart does not re-park', () => {
    // The guard is `answeredSeq > restartSince`, exactly engine.ts:223 — once
    // the revision lands, the answer is spent.
    const log = toLog([...prelude(), ...planRound(1, 'approve'), ...reviseSpec(9, 'plan-review')])
    expect(decideNext(log, CONFIG)).toMatchObject({ kind: 'run-phase', phase: 'plan', round: 2 })
    expect(reduceBuild(log).restartSince).toBeGreaterThan(0)
    project(log) // guards only — the pending-restart branch must be off here
  })
})

describe('f_7edf2816: `current` is scoped to the current spec too', () => {
  // The plan's rule only ever quantified over `done`, so `at()` read the
  // full-log `currentPhase` — which `spec.revised` does not touch, because
  // `start()` sets it and only that phase's OWN terminal clears it, and
  // `escalation.raised` deliberately does not (the phase still needs
  // re-running). A phase in flight when a restart lands therefore kept
  // rendering as running.
  //
  // The canonical revise-spec path, no mutation, default config: an
  // implementer escalates because the spec is self-contradictory (an accepted
  // phase terminal, §8.4), so `implement.completed` never lands.
  const escalatedMidImplement = [
    ...prelude(),
    ...planRound(1, 'approve'),
    ev('implement.started', { round: 1 }),
    ev('escalation.raised', {
      id: 'e_respec',
      phase: 'implement',
      round: 1,
      source: 'agent',
      question: 'the spec contradicts itself',
    }),
    ev('escalation.answered', {
      id: 'e_respec',
      answer: 'rewriting it',
      resolution: 'revise-spec',
    }),
  ]
  const restartLanded = [
    ...escalatedMidImplement,
    ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: 10 }),
  ]

  test('window A — pending restart: nothing is running, so nothing is current', () => {
    const log = toLog(escalatedMidImplement)
    // The build is parked on the human. It is NOT blocked (the escalation is
    // answered), so it is listed and reads `running` — the operator sees the
    // row and must not be told `implement` is in flight.
    expect(decideNext(log, CONFIG)).toEqual({ kind: 'wait', reason: 'awaiting-spec' })
    expect(reduceBuild(log).currentPhase).toMatchObject({ phase: 'implement', round: 1 })

    const build = project(log)
    expect(build.status).toBe('running')
    expect(build.blockers).toEqual([])
    expect(build.steps.filter((s) => s.state === 'current')).toEqual([])
  })

  test('window B — restart landed: the engine runs plan r2, so implement is not current', () => {
    const log = toLog(restartLanded)
    expect(decideNext(log, CONFIG)).toMatchObject({ kind: 'run-phase', phase: 'plan', round: 2 })
    // The reducer still carries the pre-restart context — that is the fact the
    // row may not be built from, exactly as with `plan.approved` and `prState`.
    expect(reduceBuild(log).currentPhase).toMatchObject({ phase: 'implement', round: 1 })

    const build = project(log)
    expect(stateOf(build, 'implement')).toBe('pending')
    expect(build.steps.filter((s) => s.state === 'current')).toEqual([])
  })

  test('…and plan goes current once the post-restart plan.started lands', () => {
    const build = project(toLog([...restartLanded, ev('plan.started', { round: 2 })]))
    expect(stateOf(build, 'plan')).toBe('current')
    expect(stateOf(build, 'implement')).toBe('pending')
  })

  test('a completed pre-restart phase leaves nothing current either (lastCompletedPhase is full-log)', () => {
    // `currentPhase` and `lastCompletedPhase` both survive a restart. Here the
    // pre-restart phase COMPLETED, so `currentPhase` is clear and only
    // `lastCompletedPhase` carries the stale context — but the scoped `current`
    // predicate keys off `currentPhase` only, so nothing reads as running.
    const log = toLog([
      ...prelude(),
      ...planRound(1, 'approve'),
      ...codeRound(1, 'approve'),
      ...reviseSpec(13, 'code-review'),
    ])
    expect(reduceBuild(log).phase).toBe('code-review')
    expect(project(log).steps.filter((s) => s.state === 'current')).toEqual([])
  })

  test('no restart ⇒ current behaves exactly as before', () => {
    const build = project(toLog([...prelude(), ...planRound(1, 'approve'), ev('implement.started', { round: 1 })]))
    expect(stateOf(build, 'implement')).toBe('current')
  })
})

describe('f_3535ef75 / merge is gated on drained work', () => {
  const throughPr = [
    ...throughCodeReview(),
    ...verifyRun('lint', 1, true),
    ...verifyRun('test', 1, true),
    ...finalized(),
  ]

  test('merge is current once the PR is open and everything behind it drained', () => {
    const log = toLog(throughPr)
    expect(decideNext(log, CONFIG)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
    const build = project(log)
    expect(stateOf(build, 'merge')).toBe('current')
    expect(stepFor(build, 'merge')?.qualifier).toBe('waiting')
    expect(build.pr).toEqual({ url: 'https://github.com/defrex/app/pull/7', state: 'open' })
  })

  test('a skipped verify step drains into finalize and merge without becoming a pass', () => {
    const log = toLog([
      ...throughCodeReview(),
      ...verifySkip('lint', 1, 'No lintable files changed'),
      ...verifyRun('test', 1, true),
      ...finalized(),
    ])
    expect(decideNext(log, CONFIG)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })

    const build = project(log)
    expect(stateOf(build, 'verify:lint')).toBe('done')
    expect(stepFor(build, 'verify:lint')?.qualifier).toBe('skipped')
    expect(stateOf(build, 'finalize')).toBe('done')
    expect(stateOf(build, 'merge')).toBe('current')
  })

  test('case 1: a finalize post-step still outstanding ⇒ merge not current', () => {
    const log = toLog(throughPr)
    const build = project(log, CONFIG_POST_STEPS)
    expect(stateOf(build, 'changelog')).toBe('pending')
    expect(stateOf(build, 'merge')).toBe('pending')
    expect(decideNext(log, CONFIG_POST_STEPS)).toEqual({
      kind: 'run-finalize-step',
      step: 'changelog',
    })
  })

  test('a post-step that FAILED still counts as done — post-steps are failure-tolerant (§5)', () => {
    const build = project(
      toLog([...throughPr, ev('finalize.step-completed', { step: 'changelog', ok: false })]),
      CONFIG_POST_STEPS,
    )
    expect(stateOf(build, 'changelog')).toBe('done')
    expect(stepFor(build, 'changelog')?.qualifier).toBe('failed')
    expect(stateOf(build, 'merge')).toBe('current')
  })

  test('case 2: post-reconcile, with verify re-running ⇒ merge not current', () => {
    const log = toLog([
      ...throughPr,
      ev('pr.conflicted', { baseSha: 'sha-base-2' }),
      ev('reconcile.started', { attempt: 1, baseSha: 'sha-base-2' }),
      ev('reconcile.completed', {
        mergeCommit: 'sha-merge',
        artifact: { kind: 'reconcile-notes', rev: 0 },
      }),
      ...verifyRun('lint', 2, true),
    ])
    const build = project(log)
    expect(stateOf(build, 'merge')).toBe('pending')
    expect(stateOf(build, 'verify:test')).toBe('pending')
    expect(decideNext(log, CONFIG)).toMatchObject({ kind: 'run-check', step: 'test' })
  })
})

describe('f_8cd6c173: reconcile is conditional, and stays done behind the verify re-run', () => {
  const throughPr = [
    ...throughCodeReview(),
    ...verifyRun('lint', 1, true),
    ...verifyRun('test', 1, true),
    ...finalized(),
  ]

  test('the row is absent until a conflict activates it', () => {
    expect(stepFor(project(toLog(throughPr)), 'reconcile')).toBeUndefined()
  })

  test('present and current once conflicted', () => {
    const build = project(toLog([...throughPr, ev('pr.conflicted', { baseSha: 'sha-base-2' })]))
    expect(stateOf(build, 'reconcile')).toBe('pending')
    const running = project(
      toLog([
        ...throughPr,
        ev('pr.conflicted', { baseSha: 'sha-base-2' }),
        ev('reconcile.started', { attempt: 1, baseSha: 'sha-base-2' }),
      ]),
    )
    expect(stateOf(running, 'reconcile')).toBe('current')
  })

  test('stays done while the post-reconcile verify re-runs', () => {
    // `reconcileAttempts` is full-log — legitimately: the engine routes the
    // epilogue on the same full-log values (engine.ts:402,:416), so a restart
    // genuinely does not re-run reconcile and the display agrees. Full-log is
    // not the defect; DISAGREEING with the engine is.
    const build = project(
      toLog([
        ...throughPr,
        ev('pr.conflicted', { baseSha: 'sha-base-2' }),
        ev('reconcile.started', { attempt: 1, baseSha: 'sha-base-2' }),
        ev('reconcile.completed', {
          mergeCommit: 'sha-merge',
          artifact: { kind: 'reconcile-notes', rev: 0 },
        }),
        ...verifyRun('lint', 2, true),
      ]),
    )
    expect(stateOf(build, 'reconcile')).toBe('done')
  })
})

// ── Durations (the new derivation) ────────────────────────────────────────────
//
// `toLog` stamps each event 1 s after the last (steppingClock, stepMs 1000), so
// every interval below is an exact multiple of 1000 ms and the assertions can be
// on precise durations rather than ranges. The timing is derived from the raw
// log the way the reducer never keeps it, so these run over real reduced state.

function tsMsOf(log: AbEvent[], seq: number): number {
  const ev = log.find((e) => e.seq === seq)
  if (ev === undefined) throw new Error(`no event at seq ${seq}`)
  return Date.parse(ev.ts)
}

describe('durations: accumulation and scope', () => {
  test('a done loop step sums its wall-clock across all rounds in scope (AC 11)', () => {
    // plan runs twice (revise then approve); each `.started`→`.completed` pair
    // is one 1 s step, so the cumulative plan time is exactly 2 s.
    const log = toLog([...prelude(), ...planRound(1, 'revise'), ...planRound(2, 'approve')])
    const build = project(log)
    expect(stateOf(build, 'plan')).toBe('done')
    expect(stepFor(build, 'plan')?.timing?.accumulatedMs).toBe(2000)
    expect(stepFor(build, 'plan')?.timing?.runningSince).toBeUndefined()
    expect(stepFor(build, 'plan')?.count).toBe(2)
  })

  test('a running step reports runningSince and an empty accumulator', () => {
    const log = toLog([...prelude(), ev('plan.started', { round: 1 })])
    const build = project(log)
    expect(build.status).toBe('running')
    const timing = stepFor(build, 'plan')?.timing
    expect(timing?.accumulatedMs).toBe(0)
    // The open interval stays open — the renderer ticks it against `now`.
    expect(timing?.runningSince).toBe(tsMsOf(log, 5)) // the plan.started seq
  })

  test('a paused build freezes its open timer at the last event (AC 10)', () => {
    // plan.started, then build.paused one step later: the open interval is
    // closed at the pause, so the accumulator holds that 1 s and there is no
    // live `runningSince` to advance.
    const log = toLog([...prelude(), ev('plan.started', { round: 1 }), ev('build.paused', {})])
    const build = project(log)
    expect(build.status).toBe('paused')
    const timing = stepFor(build, 'plan')?.timing
    expect(timing?.runningSince).toBeUndefined()
    expect(timing?.accumulatedMs).toBe(1000)
  })

  test('never-run steps carry no timing (AC 6)', () => {
    const build = project(toLog([...prelude(), ev('plan.started', { round: 1 })]))
    // implement has not started — no interval, no time shown.
    expect(stepFor(build, 'implement')?.timing).toBeUndefined()
  })

  test('a verify pass shows only its CURRENT-cycle time, none pre-restart (AC 12)', () => {
    // verify:lint passes once, the spec is revised (restart), then the whole
    // pipeline re-runs and verify:lint passes again. Only the post-restart
    // occurrence is in scope, so its time is a single 1 s step — the pre-restart
    // attempt is excluded exactly as its DONE state is.
    const log = toLog([
      ...throughCodeReview(),
      ...verifyRun('lint', 1, true),
      ...verifyRun('test', 1, true),
      ...finalized(),
      ...reviseSpec(19, 'finalize'),
      ...planRound(2, 'approve'),
      ...codeRound(2, 'approve'),
      ...verifyRun('lint', 2, true),
    ])
    const build = project(log)
    expect(stateOf(build, 'verify:lint')).toBe('done')
    expect(stepFor(build, 'verify:lint')?.timing?.accumulatedMs).toBe(1000) // NOT 2000
    expect(stepFor(build, 'verify:lint')?.count).toBe(2)
  })

  test('merge waiting ticks from the drain (lastEvent) ts (AC 9)', () => {
    const log = toLog([
      ...throughCodeReview(),
      ...verifyRun('lint', 1, true),
      ...verifyRun('test', 1, true),
      ...finalized(),
    ])
    const build = project(log)
    expect(stateOf(build, 'merge')).toBe('current')
    const timing = stepFor(build, 'merge')?.timing
    // finalize.completed is the last event, and merge-ready starts there.
    expect(timing?.accumulatedMs).toBe(0)
    expect(timing?.runningSince).toBe(tsMsOf(log, reduceBuild(log).lastSeq))
  })
})
