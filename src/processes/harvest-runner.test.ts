import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHarvestContext, submitHarvestProposals, submitHarvestVerdict } from '../cli/harvest'
import { resolveHarvestCliEnv } from '../cli/env'
import { parseConfig } from '../config/load'
import { KERNEL, agentActor, humanActor } from '../events/envelope'
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

  for (const pauseDuring of ['synthesize', 'review'] as const) {
    test(`pauses after the in-flight ${pauseDuring} boundary and resumes without repeating completed work`, async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), `ab-harvest-pause-${pauseDuring}-`),
      )
      roots.push(workspace)
      const store = new MemoryBuildStore({ clock: steppingClock() })
      const tickets = new FakeTicketSource()
      const ids = sequentialIds()
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
            const file = join(workspace, '.ab', 'paused-proposals.json')
            await writeFile(file, JSON.stringify(proposalSet(observations)))
            await submitHarvestProposals(deps, file)
            if (pauseDuring === 'synthesize') {
              await store.appendRepo('/repo', {
                actor: humanActor('operator'),
                type: 'harvest.pause-requested',
                payload: {},
              })
            }
          } else {
            reviewers += 1
            const notes = join(workspace, '.ab', 'paused-review.md')
            await writeFile(notes, 'approved before pause\n')
            await submitHarvestVerdict(deps, { verdict: 'approve', notes })
            if (pauseDuring === 'review') {
              await store.appendRepo('/repo', {
                actor: humanActor('operator'),
                type: 'harvest.pause-requested',
                payload: {},
              })
            }
          }
          return defaultTurnResult('done')
        },
      })
      await seedObservation(store, `pause-${pauseDuring}`, 'pause at boundary')
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

      const parked = await makeRunner('pause-boundary').run()
      expect(parked).toMatchObject({ outcome: 'parked' })
      const beforeResumeEvents = await store.getRepoEvents('/repo')
      const beforeResume = reduceHarvest(beforeResumeEvents)
      const run = beforeResume.latest!
      expect(beforeResume.paused).toBe(true)
      expect(run.status).toBe('running')
      expect(run.proposals).toHaveLength(1)
      expect(run.reviews).toHaveLength(pauseDuring === 'review' ? 1 : 0)
      expect(run.steps.some((step) => step.step === 'file')).toBe(false)
      expect(
        beforeResumeEvents.some(
          (event) =>
            event.type === 'harvest.completed' ||
            event.type === 'harvest.failed' ||
            event.type === 'harvest.escalated',
        ),
      ).toBe(false)
      expect(await tickets.get('fake-1')).toBeNull()

      await store.appendRepo('/repo', {
        actor: humanActor('operator'),
        type: 'harvest.resume-requested',
        payload: {},
      })
      expect(await makeRunner('resume-boundary').run()).toEqual({
        outcome: 'completed',
        launch: 'resumed',
        run: run.run,
      })
      const afterResumeEvents = await store.getRepoEvents('/repo')
      expect(
        afterResumeEvents.filter((event) => event.type === 'harvest.started'),
      ).toHaveLength(1)
      expect(
        afterResumeEvents.filter(
          (event) => event.type === 'harvest.proposals.submitted',
        ),
      ).toHaveLength(1)
      expect(
        afterResumeEvents.filter(
          (event) => event.type === 'harvest.review.verdict',
        ),
      ).toHaveLength(1)
      expect(producers).toBe(1)
      expect(reviewers).toBe(1)
      expect(await tickets.get('fake-1')).not.toBeNull()
      expect(reduceHarvest(afterResumeEvents)).toMatchObject({
        paused: false,
        latest: { run: run.run, status: 'completed' },
      })
    })
  }

  test('an idle pause prevents threshold launch; resume reopens normal scanning', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-pause-idle-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    let agentCalls = 0
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        agentCalls += 1
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const file = join(workspace, '.ab', 'idle-resume-proposals.json')
          await writeFile(file, JSON.stringify(proposalSet(observations)))
          await submitHarvestProposals(deps, file)
        } else {
          const notes = join(workspace, '.ab', 'idle-resume-review.md')
          await writeFile(notes, 'approved\n')
          await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        }
        return defaultTurnResult('done')
      },
    })
    await seedObservation(store, 'idle-pause', 'already over threshold')
    await store.ensureRepo('/repo')
    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.pause-requested',
      payload: {},
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

    expect(await makeRunner('idle-pause').run()).toEqual({ outcome: 'parked' })
    expect(reduceHarvest(await store.getRepoEvents('/repo'))).toMatchObject({
      paused: true,
      runs: [],
    })
    expect(agentCalls).toBe(0)
    expect(await makeRunner('still-paused').run()).toEqual({ outcome: 'parked' })
    expect(agentCalls).toBe(0)

    await store.appendRepo('/repo', {
      actor: humanActor('operator'),
      type: 'harvest.resume-requested',
      payload: {},
    })
    expect(await makeRunner('idle-resume').run()).toMatchObject({
      outcome: 'completed',
      launch: 'started',
    })
    expect(agentCalls).toBe(2)
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

  test('a replacement acknowledges an already-recorded recovery request without spending another attempt', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-request-gap-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    const seeded = await seedOpenRun({
      store,
      tickets,
      ids,
      workspace,
      stage: 'started',
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: seeded.run,
        step: 'synthesize',
        round: 1,
        attempt: 2,
        error: 'runner stopped',
        willRetry: false,
      },
    })
    // Simulate process death after durable selection but before the common
    // harvest.resumed acknowledgement.
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.recovery-requested',
      payload: { run: seeded.run, attempt: 1, limit: 2 },
    })

    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const file = join(workspace, '.ab', 'gap-proposals.json')
          await writeFile(file, JSON.stringify(proposalSet(observations)))
          await submitHarvestProposals(deps, file)
        } else {
          const notes = join(workspace, '.ab', 'gap-review.md')
          await writeFile(notes, 'approved after replacement\n')
          await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        }
        return defaultTurnResult('done')
      },
    })
    expect(
      await new HarvestRunner({
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
        instance: 'request-gap-replacement',
        opts: { heartbeatMs: 100_000 },
      }).run(),
    ).toEqual({ outcome: 'completed', launch: 'resumed', run: seeded.run })

    const events = await store.getRepoEvents('/repo')
    expect(
      events.filter((event) => event.type === 'harvest.recovery-requested'),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'harvest.resumed'),
    ).toHaveLength(1)
    expect(reduceHarvest(events).latest?.recoveryRequests).toEqual([
      expect.objectContaining({
        attempt: 1,
        acknowledgedSeq: expect.any(Number),
      }),
    ])
  })

  test('automatic recovery at review reuses the submitted proposal artifact', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-review-recovery-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    const seeded = await seedOpenRun({
      store,
      tickets,
      ids,
      workspace,
      stage: 'proposals',
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: seeded.run,
        step: 'review',
        round: 1,
        attempt: 2,
        error: 'review provider unavailable',
        willRetry: false,
      },
    })
    let producers = 0
    let reviewers = 0
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        if (opts.skill === 'ab-harvest') {
          producers += 1
          throw new Error('completed synthesize must not run again')
        }
        reviewers += 1
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        const notes = join(workspace, '.ab', 'recovered-review.md')
        await writeFile(notes, 'approved on automatic recovery\n')
        await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        return defaultTurnResult('done')
      },
    })
    expect(
      await new HarvestRunner({
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
        instance: 'review-recovery',
        opts: { heartbeatMs: 100_000 },
      }).run(),
    ).toEqual({ outcome: 'completed', launch: 'resumed', run: seeded.run })
    expect(producers).toBe(0)
    expect(reviewers).toBe(1)
    const events = await store.getRepoEvents('/repo')
    expect(
      events.filter((event) => event.type === 'harvest.proposals.submitted'),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'harvest.recovery-requested'),
    ).toHaveLength(1)
  })

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

  test('automatic recovery is durably bounded and then stops hot-looping', async () => {
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

    expect(await makeRunner('automatic-recovery-1').run()).toMatchObject({
      outcome: 'failed',
      launch: 'resumed',
      run: 'harvest_1',
    })
    expect(await makeRunner('automatic-recovery-2').run()).toMatchObject({
      outcome: 'failed',
      launch: 'resumed',
      run: 'harvest_1',
    })
    const exhaustedEvents = await store.getRepoEvents('/repo')
    const exhausted = reduceHarvest(exhaustedEvents)
    expect(exhausted.latest).toMatchObject({
      status: 'failed',
      failure: { step: 'synthesize', attempt: 4, willRetry: false },
      recoveryRequests: [
        { attempt: 1, limit: 2, acknowledgedSeq: expect.any(Number) },
        { attempt: 2, limit: 2, acknowledgedSeq: expect.any(Number) },
      ],
      recoveryExhaustion: {
        step: 'synthesize',
        round: 1,
        attempts: 2,
        limit: 2,
        releasedObservations: [{ build: 'no-terminal', seq: 1 }],
      },
    })
    expect(
      exhaustedEvents.filter(
        (event) => event.type === 'harvest.recovery-requested',
      ),
    ).toHaveLength(2)
    expect(
      exhaustedEvents.filter(
        (event) => event.type === 'harvest.recovery-exhausted',
      ),
    ).toHaveLength(1)
    expect(calls).toBe(4)
    expect(await makeRunner('attention-barrier').run()).toEqual({
      outcome: 'parked',
      run: 'harvest_1',
    })
    expect(calls).toBe(4)
  })

  test('a repaired permanent provider failure resumes the stopped occurrence', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-provider-error-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    let calls = 0
    let repaired = false
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        calls += 1
        if (!repaired) return failedTurnResult(KIMI_QUOTA, true)

        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const file = join(workspace, '.ab', 'repaired-proposals.json')
          await writeFile(file, JSON.stringify(proposalSet(observations)))
          await submitHarvestProposals(deps, file)
        } else {
          const notes = join(workspace, '.ab', 'repaired-review.md')
          await writeFile(notes, 'approved after provider repair\n')
          await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        }
        return defaultTurnResult('done')
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

    // The next runner invocation automatically reopens the same stopped run.
    repaired = true
    expect(await makeRunner('provider-repaired').run()).toEqual({
      outcome: 'completed',
      launch: 'resumed',
      run: 'harvest_1',
    })
    const repairedEvents = await store.getRepoEvents('/repo')
    const repairedState = reduceHarvest(repairedEvents)
    expect(repairedState.latest).toMatchObject({
      run: 'harvest_1',
      status: 'completed',
      observations: [{ build: 'provider-error', seq: 1 }],
      recoveryRequests: [
        { attempt: 1, limit: 2, acknowledgedSeq: expect.any(Number) },
      ],
    })
    expect(
      repairedEvents.filter((event) => event.type === 'harvest.started'),
    ).toHaveLength(1)
    expect(
      repairedEvents.filter(
        (event) => event.type === 'harvest.proposals.submitted',
      ),
    ).toHaveLength(1)
    expect(
      repairedEvents.filter((event) => event.type === 'harvest.review.verdict'),
    ).toHaveLength(1)
    expect(calls).toBe(3)
    expect(await tickets.get('fake-1')).not.toBeNull()
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

  test('an errored partial filing resumes with exactly the missing proposal', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-partial-file-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const createTitles: string[] = []
    class RepairableTickets extends FakeTicketSource {
      repaired = false

      override async create(...args: Parameters<FakeTicketSource['create']>) {
        createTitles.push(args[0].title)
        if (!this.repaired && args[0].title === 'Harvested defect 2') {
          throw new Error('ticket provider rejected the second proposal')
        }
        return super.create(...args)
      }
    }
    const tickets = new RepairableTickets()
    const ids = sequentialIds()
    await seedObservation(store, 'partial-extra', 'second claimed observation')
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
    const claimed = structuredClone(
      reduceHarvest(await store.getRepoEvents('/repo')).latest!.observations,
    )
    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('an approved filing resume must not start an agent')
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
        uuids: randomUuids(),
        clock: steppingClock(),
        instance,
        opts: { heartbeatMs: 100_000, maxSessionAttempts: 2 },
      })

    expect(await makeRunner('partial-attempt-1').run()).toEqual({
      outcome: 'failed',
      launch: 'resumed',
      run: seeded.run,
    })
    expect(await makeRunner('partial-attempt-2').run()).toEqual({
      outcome: 'failed',
      launch: 'resumed',
      run: seeded.run,
    })
    let events = await store.getRepoEvents('/repo')
    let state = reduceHarvest(events)
    expect(state.latest).toMatchObject({
      run: seeded.run,
      status: 'failed',
      failure: { step: 'file', attempt: 2, willRetry: false },
      observations: claimed,
    })
    expect(state.latest?.filed).toHaveLength(1)
    expect(createTitles).toEqual([
      'Harvested defect 1',
      'Harvested defect 2',
      'Harvested defect 2',
    ])
    expect(await tickets.get('fake-1')).not.toBeNull()
    expect(await tickets.get('fake-2')).toBeNull()

    tickets.repaired = true
    expect(await makeRunner('partial-repaired').run()).toEqual({
      outcome: 'completed',
      launch: 'resumed',
      run: seeded.run,
    })

    events = await store.getRepoEvents('/repo')
    state = reduceHarvest(events)
    expect(state.latest).toMatchObject({
      run: seeded.run,
      status: 'completed',
      observations: claimed,
      recoveryRequests: [
        { attempt: 1, limit: 2, acknowledgedSeq: expect.any(Number) },
      ],
    })
    expect(state.latest?.filed).toHaveLength(2)
    expect(createTitles).toEqual([
      'Harvested defect 1',
      'Harvested defect 2',
      'Harvested defect 2',
      'Harvested defect 2',
    ])
    expect(await tickets.get('fake-1')).not.toBeNull()
    expect(await tickets.get('fake-2')).not.toBeNull()
    expect(
      events.filter((event) => event.type === 'harvest.started'),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'harvest.proposals.submitted'),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'harvest.review.verdict'),
    ).toHaveLength(1)
    const filings = events.filter(
      (event) => event.type === 'harvest.proposal.filed',
    )
    expect(filings).toHaveLength(2)
    expect(new Set(filings.map((event) => event.payload.proposalKey)).size).toBe(2)
    expect(
      events.filter((event) => event.type === 'harvest.completed'),
    ).toHaveLength(1)
  })

  test('an approved tombstone join exhausts into pending work instead of relaunching forever', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-tombstone-exhaustion-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    await seedObservation(store, 'tombstone-join', 'join target became terminal')
    const scan = await scanUnclaimedObservations(store, '/repo')
    const run = 'h_tombstone_join'
    const packet = {
      repo: '/repo',
      run,
      observations: scan.observations,
      ledger: [
        {
          proposalKey: 'prior-cluster',
          ticket: { source: 'fake', id: 'T-gone' },
          exists: true,
          resolved: true,
        },
      ],
    }
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
    const proposal = {
      action: 'join' as const,
      ticket: { source: 'fake', id: 'T-gone' },
      observations: scan.observations.map((item) => item.occurrence),
      reason: 'The reviewer incorrectly approved a tombstone join.',
    }
    await store.appendRepoWithArtifacts(
      '/repo',
      [
        {
          kind: 'harvest-proposals',
          content: JSON.stringify({ proposals: [proposal] }),
        },
      ],
      (deposited) => ({
        actor: agentActor('harvest', 'hs_tombstone'),
        type: 'harvest.proposals.submitted',
        payload: {
          run,
          round: 1,
          artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
        },
      }),
    )
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-review', content: 'approved incorrectly\n' }],
      (deposited) => ({
        actor: agentActor('harvest-review', 'hr_tombstone'),
        type: 'harvest.review.verdict',
        payload: {
          run,
          round: 1,
          verdict: 'approve',
          findings: [],
          artifact: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
        },
      }),
    )
    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('approved tombstone recovery must not start an agent')
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
        uuids: randomUuids(),
        clock: steppingClock(),
        instance,
        opts: {
          heartbeatMs: 100_000,
          maxSessionAttempts: 1,
          maxRecoveryAttempts: 2,
        },
      })

    expect(await makeRunner('tombstone-initial').run()).toEqual({
      outcome: 'failed',
      launch: 'resumed',
      run,
    })
    expect(await makeRunner('tombstone-recovery-1').run()).toEqual({
      outcome: 'failed',
      launch: 'resumed',
      run,
    })
    expect(await makeRunner('tombstone-recovery-2').run()).toEqual({
      outcome: 'failed',
      launch: 'resumed',
      run,
    })

    const events = await store.getRepoEvents('/repo')
    const state = reduceHarvest(events)
    expect(state.latest).toMatchObject({
      run,
      status: 'failed',
      recoveryExhaustion: {
        step: 'file',
        attempts: 2,
        limit: 2,
        releasedObservations: scan.observations.map(
          (item) => item.occurrence,
        ),
        pendingProposals: [
          {
            proposalKey: harvestProposalKey(proposal),
            action: 'join',
          },
        ],
      },
    })
    expect(
      events.filter(
        (event) => event.type === 'harvest.recovery-exhausted',
      ),
    ).toHaveLength(1)
    expect(
      (await scanUnclaimedObservations(store, '/repo')).observations.map(
        (item) => item.occurrence,
      ),
    ).toEqual(scan.observations.map((item) => item.occurrence))
    expect(await makeRunner('tombstone-attention-barrier').run()).toEqual({
      outcome: 'parked',
      run,
    })
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
