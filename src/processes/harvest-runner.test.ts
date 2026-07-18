import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHarvestContext, submitHarvestProposals, submitHarvestVerdict } from '../cli/harvest'
import { resolveHarvestCliEnv } from '../cli/env'
import { parseConfig } from '../config/load'
import { KERNEL, agentActor } from '../events/envelope'
import { randomUuids, sequentialIds } from '../ids'
import { reduceHarvest } from '../kernel/harvest'
import { harvestProposalKey, makeHarvestScanPacket, scanUnclaimedObservations } from './harvest'
import {
  ScriptedAgentRunner,
  defaultTurnResult,
  failedTurnResult,
} from '../ports/runner/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import { HarvestRunner } from './harvest-runner'

const roots: string[] = []
const KIMI_QUOTA =
  '403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Please try again after your quota refreshes."}}'
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function countingUuids() {
  const platform = randomUuids()
  const allocated: string[] = []
  return {
    allocated,
    source: () => {
      const id = platform()
      allocated.push(id)
      return id
    },
  }
}

async function seedObservation(store: MemoryBuildStore, build: string, summary: string): Promise<void> {
  if ((await store.getBuild(build)) === null) {
    await store.createBuild({ slug: build, repo: '/repo' })
  }
  await store.append(build, {
    actor: agentActor('implement', `s-${build}`),
    type: 'observation.recorded',
    payload: { id: `obs-${build}-${summary}`, kind: 'latent-bug', summary },
  })
}

function config(
  threshold = 2,
  policy: { maxReviewRounds?: number; stallRounds?: number } = {},
) {
  return parseConfig(
    [
      '[tickets]',
      'source = "file"',
      'readyState = "Ready"',
      '[harvest]',
      `threshold = ${threshold}`,
      '[policy]',
      `maxReviewRounds = ${policy.maxReviewRounds ?? 3}`,
      `stallRounds = ${policy.stallRounds ?? 3}`,
    ].join('\n'),
  )
}

function proposalSet(
  observations: Array<{ occurrence: { build: string; seq: number } }>,
  title = 'Harvested defect',
) {
  return {
    proposals: [
      {
        action: 'create' as const,
        title,
        whatWhy: 'The observation describes a concrete recurring defect.',
        acceptanceCriteria: ['The recorded defect no longer occurs.'],
        outOfScope: ['Unrelated cleanup.'],
        observations: observations.map((item) => item.occurrence),
      },
    ],
  }
}

async function seedOpenRun(opts: {
  store: MemoryBuildStore
  tickets: FakeTicketSource
  ids: ReturnType<typeof sequentialIds>
  workspace: string
  stage: 'started' | 'proposals' | 'reviewed' | 'filed'
  makeProposals?: (
    observations: Parameters<typeof proposalSet>[0],
  ) => ReturnType<typeof proposalSet>
}): Promise<{ run: string; proposals: ReturnType<typeof proposalSet> }> {
  const { store, tickets, ids, workspace, stage } = opts
  await seedObservation(store, `resume-${stage}`, `${stage} boundary`)
  const run = `h_${stage}`
  const scan = await scanUnclaimedObservations(store, '/repo')
  const packet = await makeHarvestScanPacket({
    store,
    tickets,
    repo: '/repo',
    run,
    observations: scan.observations,
    state: scan.state,
  })
  await store.appendRepoWithArtifacts(
    '/repo',
    [{ kind: 'harvest-scan', content: JSON.stringify(packet) }],
    (deposited) => ({
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run,
        observations: scan.observations.map((item) => item.occurrence),
        scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
      },
    }),
  )

  const proposals = opts.makeProposals?.(scan.observations) ?? proposalSet(scan.observations)
  if (stage === 'started') return { run, proposals }

  const proposalFile = join(workspace, '.ab', `${stage}-proposals.json`)
  const synthEnv = {
    store: 'memory',
    repo: '/repo',
    run,
    phase: 'synthesize' as const,
    round: 1,
    session: 'hs_old',
  }
  await buildHarvestContext({ store, workspacePath: workspace, ids, env: synthEnv })
  await writeFile(proposalFile, JSON.stringify(proposals))
  await submitHarvestProposals(
    { store, workspacePath: workspace, ids, env: synthEnv },
    proposalFile,
  )
  if (stage === 'proposals') return { run, proposals }

  const notes = join(workspace, '.ab', `${stage}-review.md`)
  await writeFile(notes, 'approved before simulated crash\n')
  await submitHarvestVerdict(
    {
      store,
      workspacePath: workspace,
      ids,
      env: {
        store: 'memory',
        repo: '/repo',
        run,
        phase: 'review',
        round: 1,
        session: 'hr_old',
      },
    },
    { verdict: 'approve', notes },
  )
  if (stage === 'reviewed') return { run, proposals }

  const proposal = proposals.proposals[0]!
  const key = harvestProposalKey(proposal)
  const created = await tickets.create(
    {
      title: proposal.title,
      body: [
        '# Harvested defect',
        '',
        '## What and why',
        '',
        proposal.whatWhy,
        '',
        '## Acceptance criteria',
        '',
        '- The recorded defect no longer occurs.',
        '',
        '## Out of scope',
        '',
        '- Unrelated cleanup.',
      ].join('\n'),
    },
    { state: 'Triage', idempotencyKey: key },
  )
  await store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'harvest.proposal.filed',
    payload: {
      run,
      proposalKey: key,
      ticket: created.ref,
    },
  })
  return { run, proposals }
}

describe('HarvestRunner', () => {
  test('revise continues one producer session and starts a fresh reviewer each round', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-revise-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    let reviewRound = 0
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts, turn }) => {
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          if (turn === 2) {
            expect(
              JSON.parse(
                await readFile(join(workspace, '.ab', 'findings.json'), 'utf8'),
              ),
            ).toHaveLength(1)
          }
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const file = join(workspace, '.ab', `proposals-${turn}.json`)
          await writeFile(
            file,
            JSON.stringify({
              proposals: [
                {
                  action: 'create',
                  title: turn === 1 ? 'Initial title' : 'Reviewed title',
                  whatWhy: 'The observation describes an actionable defect.',
                  acceptanceCriteria: ['The defect no longer occurs.'],
                  outOfScope: ['Unrelated cleanup.'],
                  observations: observations.map((item) => item.occurrence),
                },
              ],
            }),
          )
          await submitHarvestProposals(deps, file)
        } else {
          reviewRound += 1
          const notes = join(workspace, '.ab', `review-${reviewRound}.md`)
          await writeFile(notes, reviewRound === 1 ? 'revise' : 'approve')
          if (reviewRound === 1) {
            const findings = join(workspace, '.ab', 'review-findings.json')
            await writeFile(
              findings,
              JSON.stringify([
                { severity: 'important', summary: 'Make the title specific' },
              ]),
            )
            await submitHarvestVerdict(deps, {
              verdict: 'revise',
              notes,
              findings,
            })
          } else {
            await submitHarvestVerdict(deps, { verdict: 'approve', notes })
          }
        }
        return defaultTurnResult('done')
      },
    })
    await seedObservation(store, 'one', 'first')
    const result = await new HarvestRunner({
      store,
      tickets,
      config: config(1),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      defaultRuntime: 'scripted',
      repo: '/repo',
      workspacePath: workspace,
      ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance',
      opts: { heartbeatMs: 100_000 },
    }).run()
    expect(result.outcome).toBe('completed')
    const journals = [...scripted.sessions.values()]
    const producers = journals.filter((session) => session.opts.skill === 'ab-harvest')
    const reviewers = journals.filter(
      (session) => session.opts.skill === 'ab-harvest-review',
    )
    expect(producers).toHaveLength(1)
    expect(producers[0]?.turns).toHaveLength(2)
    expect(reviewers).toHaveLength(2)
    expect(reviewers.every((session) => session.turns.length === 1)).toBe(true)
    expect((await tickets.get('fake-1'))?.title).toBe('Reviewed title')
  })

  test('below threshold is idle; threshold runs reviewed workflow, files Triage, and K new observations retrigger', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-runner-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    let reviewRounds = 0
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const proposal = {
            proposals: [
              {
                action: 'create',
                title: 'Shared observation defect',
                whatWhy: 'The recorded behavior is a recurring product defect.',
                acceptanceCriteria: ['The recorded defect no longer occurs.'],
                outOfScope: ['Unrelated cleanup is excluded.'],
                observations: observations.map((item) => item.occurrence),
              },
            ],
          }
          const file = join(workspace, '.ab', 'submit.json')
          await writeFile(file, JSON.stringify(proposal))
          await submitHarvestProposals(deps, file)
        } else {
          reviewRounds += 1
          const notes = join(workspace, '.ab', 'review.md')
          await writeFile(notes, 'approved\n')
          await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        }
        return defaultTurnResult('done')
      },
    })
    const makeRunner = () =>
      new HarvestRunner({
        store,
        tickets,
        config: config(),
        runtimes: { scripted: { runner: scripted, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: randomUuids(),
        clock: steppingClock(),
        instance: ids('instance'),
        opts: { heartbeatMs: 100_000 },
      })

    await seedObservation(store, 'one', 'first')
    expect(await makeRunner().run()).toEqual({ outcome: 'idle' })

    await seedObservation(store, 'two', 'second')
    const first = await makeRunner().run()
    expect(first.outcome).toBe('completed')
    expect(first).toMatchObject({ launch: 'started' })
    expect(reviewRounds).toBe(1)
    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.status).toBe('completed')
    expect(state.ledger).toHaveLength(2)
    expect((await tickets.get('fake-1'))?.state).toBe('Triage')
    expect(await makeRunner().run()).toEqual({ outcome: 'idle' })

    await seedObservation(store, 'three', 'third')
    expect(await makeRunner().run()).toEqual({ outcome: 'idle' })
    await seedObservation(store, 'four', 'fourth')
    expect((await makeRunner().run()).outcome).toBe('completed')
    expect(await tickets.get('fake-2')).not.toBeNull()
  })

  for (const stage of ['started', 'proposals', 'reviewed', 'filed'] as const) {
    test(`resumes after a crash at the ${stage} journal boundary`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), `ab-harvest-resume-${stage}-`))
      roots.push(workspace)
      const store = new MemoryBuildStore({ clock: steppingClock() })
      const tickets = new FakeTicketSource()
      const ids = sequentialIds()
      const uuids = countingUuids()
      const seeded = await seedOpenRun({ store, tickets, ids, workspace, stage })
      let producers = 0
      let reviewers = 0
      const scripted = new ScriptedAgentRunner({
        script: async ({ opts }) => {
          const env = resolveHarvestCliEnv(opts.env)
          const deps = { store, env, workspacePath: workspace, ids }
          await buildHarvestContext(deps)
          if (opts.skill === 'ab-harvest') {
            producers += 1
            const observations = JSON.parse(
              await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
            ) as Array<{ occurrence: { build: string; seq: number } }>
            const file = join(workspace, '.ab', 'resumed-proposals.json')
            await writeFile(file, JSON.stringify(proposalSet(observations)))
            await submitHarvestProposals(deps, file)
          } else {
            reviewers += 1
            const notes = join(workspace, '.ab', 'resumed-review.md')
            await writeFile(notes, 'approved on resume\n')
            await submitHarvestVerdict(deps, { verdict: 'approve', notes })
          }
          return defaultTurnResult('done')
        },
      })
      const runner = new HarvestRunner({
        store,
        tickets,
        config: config(1),
        runtimes: { scripted: { runner: scripted, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: uuids.source,
        clock: steppingClock(),
        instance: `resume-${stage}`,
        opts: { heartbeatMs: 100_000 },
      })

      expect(await runner.run()).toEqual({
        outcome: 'completed',
        launch: 'resumed',
        run: seeded.run,
      })
      expect(producers).toBe(stage === 'started' ? 1 : 0)
      expect(reviewers).toBe(stage === 'started' || stage === 'proposals' ? 1 : 0)
      expect(reduceHarvest(await store.getRepoEvents('/repo')).latest?.status).toBe(
        'completed',
      )
      expect(await tickets.get('fake-1')).not.toBeNull()
      expect(await tickets.get('fake-2')).toBeNull()
      expect(uuids.allocated).toHaveLength(stage === 'filed' ? 0 : 1)
      expect(await runner.run()).toEqual({ outcome: 'idle' })
    })
  }

  test('a held repository lease excludes a duplicate launch', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-held-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    expect(await store.claimRepoLease('/repo', 'other-dispatcher', 3_600_000)).toBe(
      true,
    )
    let calls = 0
    const scripted = new ScriptedAgentRunner({
      script: () => {
        calls += 1
        return defaultTurnResult()
      },
    })
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      defaultRuntime: 'scripted',
      repo: '/repo',
      workspacePath: workspace,
      ids: sequentialIds(),
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'contender',
    }).run()

    expect(result).toEqual({ outcome: 'held' })
    expect(calls).toBe(0)
    expect(await store.getRepoEvents('/repo')).toEqual([])
  })

  test('a rejected heartbeat is contained and a later false beat stops at the next durable boundary', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-heartbeat-loss-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const originalClaim = store.claimRepoLease.bind(store)
    const originalHeartbeat = store.heartbeatRepo.bind(store)
    let claims = 0
    let beats = 0
    store.claimRepoLease = async (...args) => {
      claims += 1
      if (claims === 1) return originalClaim(...args)
      // A replacement won the lease after the positive lapsed-lease signal.
      return false
    }
    store.heartbeatRepo = async (...args) => {
      beats += 1
      if (beats === 1) return originalHeartbeat(...args)
      if (beats === 2) throw new Error('transient remote-store outage')
      return false
    }

    let producerCalls = 0
    let reviewerCalls = 0
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        if (opts.skill === 'ab-harvest') producerCalls += 1
        else reviewerCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return defaultTurnResult('turn crossed lease expiry without a terminal')
      },
    })
    await seedObservation(store, 'heartbeat-loss', 'lease ownership changed')

    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      defaultRuntime: 'scripted',
      repo: '/repo',
      workspacePath: workspace,
      ids: sequentialIds(),
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'former-owner',
      opts: {
        heartbeatMs: 1,
        leaseTtlMs: 3_600_000,
      },
    }).run()

    expect(result).toEqual({ outcome: 'held' })
    expect(beats).toBeGreaterThanOrEqual(3)
    expect(claims).toBe(2)
    expect(producerCalls).toBe(1)
    expect(reviewerCalls).toBe(0)
    expect(
      (await store.getRepoEvents('/repo')).some(
        (event) => event.type === 'harvest.failed',
      ),
    ).toBe(false)
  })

  test('no-terminal sessions retry across process restarts, then fail terminally without hot-looping', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-no-terminal-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    let calls = 0
    const scripted = new ScriptedAgentRunner({
      script: () => {
        calls += 1
        return defaultTurnResult('agent exited without depositing')
      },
    })
    await seedObservation(store, 'no-terminal', 'agent omitted terminal')
    const makeRunner = (instance: string) =>
      new HarvestRunner({
        store,
        tickets,
        config: config(1),
        runtimes: { scripted: { runner: scripted, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: randomUuids(),
        clock: steppingClock(),
        instance,
        opts: { heartbeatMs: 100_000, maxSessionAttempts: 2 },
      })

    expect(await makeRunner('attempt-1').run()).toMatchObject({
      outcome: 'failed',
      launch: 'started',
    })
    expect(reduceHarvest(await store.getRepoEvents('/repo')).latest).toMatchObject({
      status: 'running',
      failure: { step: 'synthesize', attempt: 1, willRetry: true },
    })
    expect(await makeRunner('attempt-2').run()).toMatchObject({
      outcome: 'failed',
      launch: 'resumed',
    })
    expect(reduceHarvest(await store.getRepoEvents('/repo')).latest).toMatchObject({
      status: 'failed',
      failure: { step: 'synthesize', attempt: 2, willRetry: false },
    })
    expect(calls).toBe(2)
    expect(await tickets.get('fake-1')).toBeNull()
    expect(await makeRunner('attempt-3').run()).toEqual({ outcome: 'idle' })
    expect(calls).toBe(2)
  })

  test('a permanent provider failure terminalizes the durable run after one session', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-provider-error-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    let calls = 0
    const scripted = new ScriptedAgentRunner({
      script: () => {
        calls += 1
        return failedTurnResult(KIMI_QUOTA, true)
      },
    })
    await seedObservation(store, 'provider-error', 'quota rejection during harvest')
    const makeRunner = (instance: string) =>
      new HarvestRunner({
        store,
        tickets,
        config: config(1),
        runtimes: { scripted: { runner: scripted, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: randomUuids(),
        clock: steppingClock(),
        instance,
        opts: { heartbeatMs: 100_000, maxSessionAttempts: 2 },
      })

    expect(await makeRunner('provider-attempt-1').run()).toMatchObject({
      outcome: 'failed',
      launch: 'started',
    })
    const events = await store.getRepoEvents('/repo')
    const failure = events.find((event) => event.type === 'harvest.failed')
    expect(failure?.payload).toMatchObject({
      step: 'synthesize',
      round: 1,
      attempt: 1,
      error: KIMI_QUOTA,
      willRetry: false,
    })
    expect(
      events.filter((event) => event.type === 'harvest.session.started'),
    ).toHaveLength(1)
    const ended = events.find((event) => event.type === 'harvest.session.ended')
    expect(ended).toBeDefined()
    if (ended?.type !== 'harvest.session.ended') throw new Error('unreachable')
    const transcript = await store.getRepoArtifact(
      '/repo',
      ended.payload.transcript.kind,
      ended.payload.transcript.rev,
    )
    const transcriptJson = JSON.parse(new TextDecoder().decode(transcript!.content))
    expect(transcriptJson.turns[0].result.failure.message).toBe(KIMI_QUOTA)
    expect(reduceHarvest(events).latest?.status).toBe('failed')
    expect(calls).toBe(1)

    // A fresh process consults the reducer/open-run gate and cannot re-enter
    // executeSession for this terminal run.
    expect(await makeRunner('provider-attempt-2').run()).toEqual({ outcome: 'idle' })
    expect(calls).toBe(1)
  })

  test('max review rounds escalate without filing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-policy-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const file = join(workspace, '.ab', 'policy-proposals.json')
          await writeFile(file, JSON.stringify(proposalSet(observations)))
          await submitHarvestProposals(deps, file)
        } else {
          const notes = join(workspace, '.ab', 'policy-review.md')
          const findings = join(workspace, '.ab', 'policy-findings.json')
          await writeFile(notes, 'revise\n')
          await writeFile(
            findings,
            JSON.stringify([{ severity: 'important', summary: 'Needs another round' }]),
          )
          await submitHarvestVerdict(deps, { verdict: 'revise', notes, findings })
        }
        return defaultTurnResult('done')
      },
    })
    await seedObservation(store, 'policy', 'bounded review')

    expect(
      await new HarvestRunner({
        store,
        tickets,
        config: config(1, { maxReviewRounds: 1, stallRounds: 3 }),
        runtimes: { scripted: { runner: scripted, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: randomUuids(),
        clock: steppingClock(),
        instance: 'policy',
        opts: { heartbeatMs: 100_000 },
      }).run(),
    ).toMatchObject({ outcome: 'escalated', launch: 'started' })
    expect(reduceHarvest(await store.getRepoEvents('/repo')).latest).toMatchObject({
      status: 'escalated',
      escalation: { source: 'policy', round: 1 },
    })
    expect(await tickets.get('fake-1')).toBeNull()
  })

  test('persistent review findings trigger stall escalation without filing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-stall-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    let previousFinding: string | undefined
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts, turn }) => {
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const file = join(workspace, '.ab', `stall-proposals-${turn}.json`)
          await writeFile(file, JSON.stringify(proposalSet(observations)))
          await submitHarvestProposals(deps, file)
        } else {
          const notes = join(workspace, '.ab', `stall-review-${env.round}.md`)
          const findings = join(workspace, '.ab', `stall-findings-${env.round}.json`)
          await writeFile(notes, 'same finding persists\n')
          await writeFile(
            findings,
            JSON.stringify([
              {
                severity: 'important',
                summary: 'Same unresolved issue',
                ...(previousFinding === undefined
                  ? {}
                  : { persists: [previousFinding] }),
              },
            ]),
          )
          const verdict = await submitHarvestVerdict(deps, {
            verdict: 'revise',
            notes,
            findings,
          })
          previousFinding = verdict.payload.findings[0]!.id
        }
        return defaultTurnResult('done')
      },
    })
    await seedObservation(store, 'stall', 'persistent finding')

    expect(
      await new HarvestRunner({
        store,
        tickets,
        config: config(1, { maxReviewRounds: 5, stallRounds: 2 }),
        runtimes: { scripted: { runner: scripted, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: randomUuids(),
        clock: steppingClock(),
        instance: 'stall',
        opts: { heartbeatMs: 100_000 },
      }).run(),
    ).toMatchObject({ outcome: 'escalated', launch: 'started' })
    expect(reduceHarvest(await store.getRepoEvents('/repo')).latest).toMatchObject({
      status: 'escalated',
      escalation: { source: 'stall', round: 2 },
    })
    expect(await tickets.get('fake-1')).toBeNull()
  })

  test('reserves a distinct UUID durably before each approved external create', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-reserve-order-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const createIds: string[] = []
    class InspectingTickets extends FakeTicketSource {
      override async create(...args: Parameters<FakeTicketSource['create']>) {
        const reservedId = args[1]?.idempotencyKey
        expect(reservedId).toBeDefined()
        const current = reduceHarvest(await store.getRepoEvents('/repo')).latest
        const reservation = current?.reservations.find(
          (entry) => entry.id === reservedId,
        )
        expect(reservation).toBeDefined()
        expect(
          current?.filed.some(
            (entry) => entry.proposalKey === reservation?.proposalKey,
          ),
        ).toBe(false)
        createIds.push(reservedId!)
        return super.create(...args)
      }
    }
    const tickets = new InspectingTickets()
    const ids = sequentialIds()
    await seedObservation(store, 'reserve-extra', 'second approved proposal')
    const seeded = await seedOpenRun({
      store,
      tickets,
      ids,
      workspace,
      stage: 'reviewed',
      makeProposals: (observations) => ({
        proposals: observations.map((item, index) => ({
          action: 'create' as const,
          title: `Harvested defect ${index + 1}`,
          whatWhy: 'The observation describes a concrete recurring defect.',
          acceptanceCriteria: ['The recorded defect no longer occurs.'],
          outOfScope: ['Unrelated cleanup.'],
          observations: [item.occurrence],
        })),
      }),
    })
    const uuids = countingUuids()
    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('approved run should not start another agent')
      },
    })

    expect(
      await new HarvestRunner({
        store,
        tickets,
        config: config(1),
        runtimes: { scripted: { runner: neverRun, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: uuids.source,
        clock: steppingClock(),
        instance: 'reserve-order',
        opts: { heartbeatMs: 100_000 },
      }).run(),
    ).toEqual({ outcome: 'completed', launch: 'resumed', run: seeded.run })

    expect(createIds).toEqual(uuids.allocated)
    expect(new Set(uuids.allocated).size).toBe(2)
    expect(await tickets.get('fake-1')).not.toBeNull()
    expect(await tickets.get('fake-2')).not.toBeNull()
    const events = await store.getRepoEvents('/repo')
    const reservations = events.filter(
      (event) => event.type === 'harvest.proposal.id-reserved',
    )
    const filings = events.filter(
      (event) => event.type === 'harvest.proposal.filed',
    )
    expect(reservations).toHaveLength(2)
    expect(filings).toHaveLength(2)
    for (const reservation of reservations) {
      const filed = filings.find(
        (event) => event.payload.proposalKey === reservation.payload.proposalKey,
      )
      expect(filed?.seq).toBeGreaterThan(reservation.seq)
    }
  })

  test('a retry after pre-create interruption reuses the durable reservation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-before-create-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const createIds: Array<string | undefined> = []
    class FailBeforeCreateTickets extends FakeTicketSource {
      private interrupted = false

      override async create(...args: Parameters<FakeTicketSource['create']>) {
        createIds.push(args[1]?.idempotencyKey)
        if (!this.interrupted) {
          this.interrupted = true
          throw new Error('simulated interruption before external create')
        }
        return super.create(...args)
      }
    }
    const tickets = new FailBeforeCreateTickets()
    const ids = sequentialIds()
    const uuids = countingUuids()
    const seeded = await seedOpenRun({
      store,
      tickets,
      ids,
      workspace,
      stage: 'reviewed',
    })
    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('approved run should not start another agent')
      },
    })
    const makeRunner = (instance: string) =>
      new HarvestRunner({
        store,
        tickets,
        config: config(1),
        runtimes: { scripted: { runner: neverRun, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: uuids.source,
        clock: steppingClock(),
        instance,
        opts: { heartbeatMs: 100_000 },
      })

    expect(await makeRunner('before-create').run()).toEqual({
      outcome: 'failed',
      launch: 'resumed',
      run: seeded.run,
    })
    expect(await tickets.get('fake-1')).toBeNull()
    expect(uuids.allocated).toHaveLength(1)
    expect(reduceHarvest(await store.getRepoEvents('/repo')).latest).toMatchObject({
      status: 'running',
      reservations: [{ id: uuids.allocated[0] }],
      filed: [],
    })

    expect(await makeRunner('after-create').run()).toEqual({
      outcome: 'completed',
      launch: 'resumed',
      run: seeded.run,
    })
    expect(uuids.allocated).toHaveLength(1)
    expect(createIds).toEqual([uuids.allocated[0], uuids.allocated[0]])
    expect(await tickets.get('fake-1')).not.toBeNull()
    expect(await tickets.get('fake-2')).toBeNull()
  })

  test('create-then-crash retry adopts one ticket before committing the ledger', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-create-crash-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const createKeys: Array<string | undefined> = []
    class CreateThenCrashTickets extends FakeTicketSource {
      crashed = false
      override async create(...args: Parameters<FakeTicketSource['create']>) {
        createKeys.push(args[1]?.idempotencyKey)
        const ticket = await super.create(...args)
        if (!this.crashed) {
          this.crashed = true
          throw new Error('simulated crash after external create')
        }
        return ticket
      }
    }
    const tickets = new CreateThenCrashTickets()
    const ids = sequentialIds()
    const uuids = countingUuids()
    let producerCalls = 0
    let reviewerCalls = 0
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          producerCalls += 1
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const file = join(workspace, '.ab', 'crash-proposals.json')
          await writeFile(file, JSON.stringify(proposalSet(observations)))
          await submitHarvestProposals(deps, file)
        } else {
          reviewerCalls += 1
          const notes = join(workspace, '.ab', 'crash-review.md')
          await writeFile(notes, 'approved\n')
          await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        }
        return defaultTurnResult('done')
      },
    })
    await seedObservation(store, 'create-crash', 'exactly once filing')
    const makeRunner = (instance: string) =>
      new HarvestRunner({
        store,
        tickets,
        config: config(1),
        runtimes: { scripted: { runner: scripted, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: uuids.source,
        clock: steppingClock(),
        instance,
        opts: { heartbeatMs: 100_000 },
      })

    expect(await makeRunner('before-crash').run()).toMatchObject({
      outcome: 'failed',
      launch: 'started',
    })
    expect(await tickets.get('fake-1')).not.toBeNull()
    const interrupted = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(interrupted.ledger).toEqual([])
    expect(interrupted.latest?.reservations).toEqual([
      expect.objectContaining({ id: uuids.allocated[0] }),
    ])

    expect(await makeRunner('after-crash').run()).toMatchObject({
      outcome: 'completed',
      launch: 'resumed',
    })
    expect(await tickets.get('fake-1')).not.toBeNull()
    expect(await tickets.get('fake-2')).toBeNull()
    expect(producerCalls).toBe(1)
    expect(reviewerCalls).toBe(1)
    expect(uuids.allocated).toHaveLength(1)
    expect(createKeys).toEqual([uuids.allocated[0], uuids.allocated[0]])
    expect(reduceHarvest(await store.getRepoEvents('/repo')).ledger).toHaveLength(1)
  })

  for (const terminalState of ['Done', 'Cancelled'] as const) {
    test(`a prior proposal in ${terminalState} is reconciled and suppressed rather than recreated`, async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), `ab-harvest-resolved-${terminalState.toLowerCase()}-`),
      )
      roots.push(workspace)
      const store = new MemoryBuildStore({ clock: steppingClock() })
      const tickets = new FakeTicketSource([], { doneState: terminalState })
      const ids = sequentialIds()
      let producerRuns = 0
      const scripted = new ScriptedAgentRunner({
        script: async ({ opts }) => {
          const env = resolveHarvestCliEnv(opts.env)
          const deps = { store, env, workspacePath: workspace, ids }
          await buildHarvestContext(deps)
          if (opts.skill === 'ab-harvest') {
            producerRuns += 1
            const observations = JSON.parse(
              await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
            ) as Array<{ occurrence: { build: string; seq: number } }>
            const file = join(workspace, '.ab', `resolved-${producerRuns}.json`)
            if (producerRuns === 1) {
              await writeFile(file, JSON.stringify(proposalSet(observations)))
            } else {
              const ledger = JSON.parse(
                await readFile(join(workspace, '.ab', 'ledger.json'), 'utf8'),
              ) as Array<{ ticket: { id: string }; resolved: boolean }>
              expect(ledger).toEqual([
                expect.objectContaining({
                  ticket: expect.objectContaining({ id: 'fake-1' }),
                  resolved: true,
                }),
              ])
              await writeFile(
                file,
                JSON.stringify({
                  proposals: [
                    {
                      action: 'suppress',
                      observations: observations.map((item) => item.occurrence),
                      reason: `the matching proposal is already ${terminalState}`,
                    },
                  ],
                }),
              )
            }
            await submitHarvestProposals(deps, file)
          } else {
            const notes = join(workspace, '.ab', `resolved-review-${env.run}.md`)
            await writeFile(notes, 'approved\n')
            await submitHarvestVerdict(deps, { verdict: 'approve', notes })
          }
          return defaultTurnResult('done')
        },
      })
      const makeRunner = (instance: string) =>
        new HarvestRunner({
          store,
          tickets,
          config: config(1),
          runtimes: { scripted: { runner: scripted, servesModels: [''] } },
          defaultRuntime: 'scripted',
          repo: '/repo',
          workspacePath: workspace,
          ids,
          uuids: randomUuids(),
          clock: steppingClock(),
          instance,
          opts: { heartbeatMs: 100_000 },
        })

      await seedObservation(store, `resolved-${terminalState}-1`, 'original defect')
      expect((await makeRunner('initial').run()).outcome).toBe('completed')
      await tickets.transition('fake-1', terminalState)

      await seedObservation(store, `resolved-${terminalState}-2`, 'same resolved defect')
      expect((await makeRunner('reconcile').run()).outcome).toBe('completed')
      expect(await tickets.get('fake-2')).toBeNull()
      expect(producerRuns).toBe(2)
      expect(reduceHarvest(await store.getRepoEvents('/repo')).ledger.at(-1)).toMatchObject({
        action: 'suppressed',
      })
    })
  }
})
