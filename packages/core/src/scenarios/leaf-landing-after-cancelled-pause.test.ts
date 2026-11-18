/**
 * GitHub #944: a green leaf whose PR was open, clean and settled never received
 * `landing.decided`. The build's history held a pause that a resume cancelled
 * before any runner acknowledged it, a finalize execution that ended with exit
 * code 1 while the target moved, a conflicted PR, a reconcile and repeated clean
 * restacks. In-memory: memory store, fakes, logical workspaces, manual clock.
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { EventWrite } from '../events/catalog'
import { DISPATCHER, KERNEL, agentActor, humanActor, type Actor } from '../events/envelope'
import type { EventPayload, EventType } from '../events/payloads'
import { sequentialIds } from '../ids'
import { decideNextFromFacts, type Decision } from '../kernel/engine'
import { actionableCommands, landRefusalReason } from '../kernel/landing-readiness'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import { Dispatcher } from '../processes/dispatcher'
import { MemoryBuildStore } from '../store/memory'
import { detailFromFacts, projectBuildDecision } from '../cli/status'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  effectiveBuildConfigContent,
} from '../processes/build-execution-state'
import { buildConfigIdentity } from '../processes/verify-cycle-config'
import { readBuildFacts } from '../store/reduced-reads'
import { manualClock } from '../testing/fixed'
import { memoryStoreRequestCounter } from '../testing/reduced-read-budget'

const REPO = '/repos/origin'
const SLUG = 'h6-vwap-adapter'
const TICKET = 'T-h6'
const sha = (c: string) => c.repeat(40)
const BASE = sha('a')

const CONFIG = parseConfig(`
[commands]
test = "bun test"

[verify]
steps = ["unit"]

[verify.unit]
kind = "check"
command = "test"

[[merge]]
mode = "consent"

[tickets]
source = "file"
readyState = "Ready"
`)

function harness() {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  const tickets = new FakeTicketSource([])
  const forge = new FakeForge({})
  forge.seedBranch('main', BASE)
  let target = BASE
  const dispatcher = new Dispatcher({
    store,
    tickets,
    workspaces: new FakeWorkspaceProvider({
      root: '/ws',
      mode: 'logical',
      base: { source: 'remote', sha: BASE },
    }),
    forge,
    config: CONFIG,
    repo: REPO,
    exec: async () => ({ stdout: `${target}\trefs/heads/main\n`, stderr: '', exitCode: 0 }),
    launchRunner: async () => 'scheduled',
    ids: sequentialIds(),
    clock,
  })
  const append = <T extends EventType>(type: T, payload: EventPayload<T>, actor: Actor = KERNEL) =>
    store.append(SLUG, { actor, type, payload } as EventWrite)
  const moveTarget = async (to: string) => {
    target = to
    forge.seedBranch('main', to)
    await append('target.moved', { branch: 'main', sha: to }, DISPATCHER)
  }
  const decide = async (): Promise<Decision> => {
    const facts = (await readBuildFacts(store, SLUG)).value
    return decideNextFromFacts(facts.state, facts.log, CONFIG)
  }
  const tick = () => dispatcher.tick({ acceptNewWork: false })
  const events = () => store.getEvents(SLUG)
  return { clock, store, tickets, forge, append, moveTarget, decide, tick, events }
}

async function seed(h: Harness) {
  await h.tickets.create({ title: SLUG, body: 'body', labels: [] }, { requestedId: TICKET })
  const ticket = { source: 'fake', id: TICKET, title: SLUG }
  await h.store.createBuild({ slug: SLUG, repo: REPO, ticket, branch: `ab/${SLUG}` })
  await h.append('build.created', { ticket, repo: REPO, baseBranch: 'main' }, DISPATCHER)
  await h.append(
    'workspace.provisioned',
    {
      provider: 'fake',
      ref: `/ws/ab/${SLUG}`,
      branch: `ab/${SLUG}`,
      base: { source: 'remote', sha: BASE },
    },
    DISPATCHER,
  )
  await h.append('spec.imported', { artifact: { kind: 'spec', rev: 0 }, ticket }, DISPATCHER)
  await h.append('target.moved', { branch: 'main', sha: BASE }, DISPATCHER)
  await h.append('runner.attached', { instance: 'runner-1', host: 'local' })
  for (const [phase, verdict] of [
    ['plan', undefined],
    ['plan-review', 'approve'],
    ['implement', undefined],
    ['code-review', 'approve'],
  ] as const) {
    await h.append(`${phase}.started` as 'plan.started', { round: 1 })
    const actor = agentActor(phase, `s_${phase}`)
    if (phase === 'plan')
      await h.append('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }, actor)
    else if (phase === 'implement')
      await h.append(
        'implement.completed',
        {
          round: 1,
          commits: { base: BASE, head: sha('b') },
          artifact: { kind: 'implement-notes', rev: 0 },
        },
        actor,
      )
    else
      await h.append(
        `${phase}.verdict` as 'plan-review.verdict',
        { round: 1, verdict: verdict!, findings: [], artifact: { kind: phase, rev: 0 } },
        actor,
      )
  }
}

type Harness = ReturnType<typeof harness>

/** Append what the engine asks for until it parks the leaf, the way a runner
 * would: clean restacks onto the observed target, passing checks, a finalize
 * that opens the PR. Returns the parking decision. */
async function drive(
  h: Harness,
  opts: { conflict?: boolean } = {},
  log: string[] = [],
): Promise<Decision> {
  let conflict = opts.conflict ?? false
  for (let guard = 0; guard < 40; guard++) {
    const decision = await h.decide()
    log.push(JSON.stringify(decision))
    const facts = (await readBuildFacts(h.store, SLUG)).value
    switch (decision.kind) {
      case 'restack': {
        const head = facts.state.pr?.headSha ?? sha('b')
        const targetBase = facts.log.restack.target?.sha ?? BASE
        const transaction = {
          id: `restack-${guard}-${decision.cycle}`,
          trigger: decision.trigger,
          cycle: decision.cycle,
          observation: facts.log.restack.target?.seq ?? 1,
          branch: `ab/${SLUG}`,
          oldHead: head,
          oldBase: facts.log.restack.completed?.targetBase ?? BASE,
          targetBase,
          changeSha: head,
          workspaceHead: head,
          localBranchHead: head,
          message: 'Leaf change\n',
        }
        await h.append('restack.prepared', transaction)
        if (conflict) {
          conflict = false
          await h.append('restack.replayed', { id: transaction.id, conflicted: true })
          break
        }
        const headSha = targetBase === transaction.oldBase ? head : nextSha()
        await h.append('restack.replayed', { id: transaction.id, conflicted: false })
        await h.append('restack.publish-intended', { ...transaction, headSha })
        await h.append('restack.rewritten', { ...transaction, headSha, archives: [] })
        await h.append('restack.completed', { ...transaction, headSha })
        break
      }
      case 'run-verify-stage':
        for (const member of decision.members) await pass(h, member.step, member.attempt)
        break
      case 'run-check':
      case 'run-agent-verify':
      case 'evaluate-verify':
        await pass(h, decision.step, decision.attempt)
        break
      case 'run-phase': {
        const active = facts.log.restack.active
        if (decision.phase !== 'reconcile' || !active) return decision
        const attempt = decision.reconcile!.attempt
        const { trigger: _t, cycle: _c, observation: _o, message: _m, ...shape } = active
        const transaction = { ...shape, id: `reconcile-${attempt}`, attempt, restackId: active.id }
        const headSha = nextSha()
        const artifact = { kind: 'reconcile-notes', rev: attempt - 1 }
        await h.append('reconcile.started', {
          attempt,
          baseSha: active.targetBase,
          restackId: active.id,
        })
        await h.append('reconcile.prepared', transaction)
        await h.append('reconcile.replayed', { id: transaction.id, conflicted: true })
        await h.append('reconcile.publish-intended', {
          ...transaction,
          headSha,
          conflicted: true,
          artifact,
        })
        await h.append('reconcile.rewritten', {
          ...transaction,
          headSha,
          conflicted: true,
          archives: [],
        })
        const completed = await h.append(
          'reconcile.completed',
          { headSha, rewriteId: transaction.id, artifact },
          agentActor('reconcile', `s_reconcile_${attempt}`),
        )
        await h.append('restack.completed', { ...active, cycle: completed.seq, headSha })
        break
      }
      case 'capture-reconcile-policy':
        await h.append('verify.reconcile-policy-captured', {
          reconcileSeq: decision.reconcileSeq,
          steps: [{ step: 'unit', enabled: true, source: 'verify.afterReconcile' }],
        })
        break
      default:
        return decision
    }
  }
  throw new Error(`engine did not park: ${log.join('\n')}`)
}

async function pass(h: Harness, step: string, attempt: number) {
  await h.append('verify.started', { step, attempt })
  await h.append('verify.completed', { step, attempt, outcome: 'pass' })
}

let shaCounter = 0
function nextSha(): string {
  shaCounter += 1
  return shaCounter.toString(16).padStart(40, 'e')
}

const PR_HEAD = sha('b')

/** Finalize opens the PR; the target moves underneath it; its session is
 * reclaimed and the execution ends `completed` with exit code 1. */
async function finalizeWithExit1(h: Harness, movedTo: string) {
  await h.append(
    'execution.started',
    {
      provider: 'fake',
      workspaceRef: `/ws/ab/${SLUG}`,
      instance: 'runner-1',
    },
    DISPATCHER,
  )
  await h.append('finalize.started', {})
  await h.append('session.started', {
    session: 's_finalize',
    role: 'finalize',
    runner: 'claude',
    phase: 'finalize',
  })
  await h.append('finalize.completed', {
    pr: { number: 1, url: 'https://fake.forge/pr/1', headSha: PR_HEAD },
  })
  await h.moveTarget(movedTo)
  await h.append('session.ended', {
    session: 's_finalize',
    outcome: 'reclaimed',
    reclaimedBy: { instance: 'runner-2', resumedFromSeq: 1 },
  })
  await h.append(
    'execution.ended',
    {
      instance: 'runner-1',
      workspaceRef: `/ws/ab/${SLUG}`,
      outcome: 'completed',
      exitCode: 1,
    },
    DISPATCHER,
  )
}

const decisions = async (h: Harness) =>
  (await h.events()).flatMap((e) => (e.type === 'landing.decided' ? [e.payload] : []))

async function replayReport(h: Harness, cancelledPause: boolean) {
  await seed(h)
  if (cancelledPause) {
    // #944: a pause and its cancelling resume, both before any runner
    // acknowledged the pause.
    await h.append('build.pause-requested', {}, humanActor('operator'))
    await h.append('build.resume-requested', {}, humanActor('operator'))
  }
  expect(await drive(h)).toMatchObject({ kind: 'run-phase', phase: 'finalize' })
  await finalizeWithExit1(h, sha('c'))
  h.forge.setPrState(1, { state: 'open', mergeable: false })
  await h.tick()
  expect((await h.events()).some((e) => e.type === 'pr.conflicted')).toBe(true)
  expect(await drive(h, { conflict: true })).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
  const types = (await h.events()).map((e) => e.type)
  expect(types).toContain('reconcile.completed')
  expect(types.lastIndexOf('verify.completed')).toBeGreaterThan(
    types.indexOf('reconcile.completed'),
  )
  h.forge.setPrState(1, { state: 'open', mergeable: true })
  await h.tick()
}

describe('a ready leaf gets a landing decision (#944)', () => {
  for (const cancelledPause of [false, true])
    test(`after exit-1 finalize, reconcile and restacks (cancelled pause: ${cancelledPause})`, async () => {
      const h = harness()
      await replayReport(h, cancelledPause)
      const expectCurrentDecision = async (count: number) => {
        const facts = (await readBuildFacts(h.store, SLUG)).value
        const decided = await decisions(h)
        expect(decided).toHaveLength(count)
        expect(decided.at(-1)!.candidate).toEqual({
          head: facts.state.pr!.headSha,
          parent: facts.log.restack.completed!.targetBase,
          cycle: String(facts.state.finalizeCompletedSeq),
        })
        return facts
      }
      expect((await h.events()).some((e) => e.type === 'pipeline.settled')).toBe(true)
      let facts = await expectCurrentDecision(1)
      expect(facts.log.restack.completed!.targetBase).toBe(sha('c'))

      // Each later clean restack that leaves the build ready is decided
      // within one poll.
      for (const [round, target] of [sha('d'), sha('f')].entries()) {
        await h.moveTarget(target)
        expect(await drive(h)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
        await h.tick()
        facts = await expectCurrentDecision(round + 2)
        expect(facts.log.restack.completed!.targetBase).toBe(target)
      }
      expect(landRefusalReason(facts.state, facts.log.restack)).toBeUndefined()
    })
})

/** A green leaf with an open, mergeable PR parked at awaiting-pr. Without a
 * verify pin, the deposited effective config is what status decides with. */
async function greenLeaf(h: Harness, beforeVerify?: () => Promise<void>) {
  await seed(h)
  if (beforeVerify) await beforeVerify()
  else
    await h.store.putArtifact(SLUG, {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(CONFIG),
    })
  expect(await drive(h)).toMatchObject({ kind: 'run-phase', phase: 'finalize' })
  await h.append('finalize.started', {})
  await h.append('finalize.completed', {
    pr: { number: 1, url: 'https://fake.forge/pr/1', headSha: PR_HEAD },
  })
  expect(await drive(h)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
  h.forge.setPrState(1, { state: 'open', mergeable: true })
}

const statusOf = async (h: Harness) => {
  const facts = (await readBuildFacts(h.store, SLUG)).value
  const decision = await projectBuildDecision(SLUG, facts, h.store)
  const record = (await h.store.getBuild(SLUG))!
  return { decision, detail: detailFromFacts(record, facts, h.clock(), undefined, decision) }
}

describe('a declined leaf states why in ab build status (#944)', () => {
  test('an unreadable source ticket is a janitor failure status names, until it recovers', async () => {
    const h = harness()
    await greenLeaf(h)
    const get = h.tickets.get.bind(h.tickets)
    h.tickets.get = async () => null
    await h.tick()
    let events = await h.events()
    expect(events.some((e) => e.type === 'landing.decided')).toBe(false)
    const failures = events.flatMap((e) =>
      e.type === 'build.janitor-attempt-failed' ? [e.payload] : [],
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]!.message).toContain(`source ticket ${TICKET}`)
    let { detail } = await statusOf(h)
    expect(detail.landingUndecided).toStartWith(
      'dispatcher janitor attempt 1 failed — Merge policy source ticket',
    )

    h.tickets.get = get
    const facts = (await readBuildFacts(h.store, SLUG)).value
    h.clock.set(facts.state.janitor!.nextAttemptAt)
    h.clock.advance(1000)
    await h.tick()
    events = await h.events()
    expect(events.filter((e) => e.type === 'landing.decided')).toHaveLength(1)
    expect(events.some((e) => e.type === 'build.janitor-recovered')).toBe(true)
    ;({ detail } = await statusOf(h))
    expect(detail.landingUndecided).toBeUndefined()
  })

  test('an open session is the stated reason', async () => {
    const h = harness()
    await greenLeaf(h)
    await h.append('session.started', {
      session: 's_late',
      role: 'reconcile',
      runner: 'claude',
      phase: 'reconcile',
    })
    await h.tick()
    expect((await h.events()).some((e) => e.type === 'landing.decided')).toBe(false)
    const { decision, detail } = await statusOf(h)
    expect(decision).toEqual({ kind: 'awaiting-pr' })
    expect(detail.landingUndecided).toBe('session s_late (reconcile) is still open')
  })

  for (const latest of ['corrupt', 'absent'] as const)
    test(`a pinned leaf with a ${latest} latest effective config`, async () => {
      const h = harness()
      await greenLeaf(h, async () => {
        const pin = await h.store.putArtifact(SLUG, {
          kind: 'verify-cycle-config',
          content: effectiveBuildConfigContent(CONFIG),
        })
        const { state } = (await readBuildFacts(h.store, SLUG)).value
        await h.append('verify.config-captured', {
          cycle: state.lastSeq + 1,
          artifact: { kind: pin.kind, rev: pin.revision },
          head: PR_HEAD,
          identity: buildConfigIdentity(CONFIG),
          source: { ref: 'branch-head', commit: PR_HEAD },
        })
      })
      if (latest === 'absent') {
        await h.tick()
        expect((await h.events()).filter((e) => e.type === 'landing.decided')).toHaveLength(1)
        const { decision, detail } = await statusOf(h)
        expect(decision).toEqual({ kind: 'awaiting-pr' })
        expect(detail.landingUndecided).toBeUndefined()
        return
      }
      await h.store.putArtifact(SLUG, {
        kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
        content: 'not json',
      })
      await h.tick()
      const report = await h.tick()
      let events = await h.events()
      expect(events.some((e) => e.type === 'landing.decided')).toBe(false)
      expect(events.some((e) => e.type === 'build.janitor-attempt-failed')).toBe(false)
      expect(report.blockedDiagnostics.some((line) => line.includes(`${SLUG} pipeline`))).toBe(true)
      let { decision, detail } = await statusOf(h)
      expect(decision).toMatchObject({ kind: 'awaiting-pr' })
      expect(decision?.kind === 'awaiting-pr' ? decision.pipelineUnreadable : '').toStartWith(
        `${BUILD_EFFECTIVE_CONFIG_ARTIFACT}@`,
      )
      expect(detail.landingUndecided).toStartWith(
        "the dispatcher cannot read this build's pipeline configuration",
      )

      await h.store.putArtifact(SLUG, {
        kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
        content: effectiveBuildConfigContent(CONFIG),
      })
      await h.tick()
      events = await h.events()
      expect(events.filter((e) => e.type === 'landing.decided')).toHaveLength(1)
      ;({ decision, detail } = await statusOf(h))
      expect(decision).toEqual({ kind: 'awaiting-pr' })
      expect(detail.landingUndecided).toBeUndefined()
    })
})

/** A green leaf whose first janitor attempt failed on an unreadable source
 * ticket, inside its backoff window. Counts every later `tickets.get`. */
async function backedOffLeaf(h: Harness) {
  await greenLeaf(h)
  const get = h.tickets.get.bind(h.tickets)
  const ticketReads = { count: 0 }
  h.tickets.get = async () => {
    ticketReads.count += 1
    return null
  }
  await h.tick()
  const failures = async () =>
    (await h.events()).filter((e) => e.type === 'build.janitor-attempt-failed')
  expect(await failures()).toHaveLength(1)
  ticketReads.count = 0
  const restore = () => {
    h.tickets.get = get
  }
  return { ticketReads, failures, restore }
}

describe('janitor failure backoff and leaf controls (AUT-1198)', () => {
  test('an inert resume waits out the backoff, then the leaf is decided', async () => {
    const h = harness()
    const { ticketReads, failures, restore } = await backedOffLeaf(h)
    // A backed-off poll with no pending command is the baseline.
    const requests = memoryStoreRequestCounter(h.store)
    await h.tick()
    const baseline = requests.vector()
    expect(ticketReads.count).toBe(0)

    await h.append('build.pause-requested', {}, humanActor('operator'))
    await h.append('build.resume-requested', {}, humanActor('operator'))
    const { state } = (await readBuildFacts(h.store, SLUG)).value
    expect(state.pendingCommands.map((c) => c.command)).toEqual(['resume'])
    expect(state.status).not.toBe('paused')
    expect(actionableCommands(state)).toEqual([])

    const lastSeq = (await h.events()).at(-1)!.seq
    for (let poll = 0; poll < 2; poll++) {
      requests.reset()
      await h.tick()
      expect(requests.vector()).toEqual(baseline)
    }
    requests.restore()
    expect(ticketReads.count).toBe(0)
    expect(await failures()).toHaveLength(1)
    expect((await h.events()).at(-1)!.seq).toBe(lastSeq)

    restore()
    h.clock.set(state.janitor!.nextAttemptAt)
    h.clock.advance(1000)
    await h.tick()
    const events = await h.events()
    expect(events.filter((e) => e.type === 'landing.decided')).toHaveLength(1)
    expect(events.some((e) => e.type === 'build.janitor-recovered')).toBe(true)
    // The inert resume still holds nothing back and stays queued.
    const after = (await readBuildFacts(h.store, SLUG)).value.state
    expect(after.pendingCommands.map((c) => c.command)).toEqual(['resume'])
  })

  const operator = humanActor('operator')
  const controls: [string, (h: Harness) => Promise<void>][] = [
    ['pause', (h) => h.append('build.pause-requested', {}, operator).then(() => {})],
    [
      'resume of a paused leaf',
      async (h) => {
        await h.append('build.pause-requested', {}, operator)
        await h.append('build.paused', {})
        await h.append('build.resume-requested', {}, operator)
      },
    ],
    [
      'abort',
      (h) => h.append('build.abort-requested', { reason: 'stop' }, operator).then(() => {}),
    ],
  ]
  for (const [name, request] of controls)
    test(`an actionable ${name} still wakes the janitor during backoff`, async () => {
      const h = harness()
      const { ticketReads, failures } = await backedOffLeaf(h)
      await request(h)
      const { state } = (await readBuildFacts(h.store, SLUG)).value
      expect(actionableCommands(state)).not.toEqual([])
      await h.tick()
      // The janitor body ran inside the backoff window: it read the ticket
      // again and, with landing held back by the control, closed the episode.
      expect(ticketReads.count).toBeGreaterThan(0)
      expect(await failures()).toHaveLength(1)
      expect((await h.events()).at(-1)!.type).toBe('build.janitor-recovered')
    })
})
