import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHarvestContext, submitHarvestProposals, submitHarvestVerdict } from '../cli/harvest'
import { resolveHarvestCliEnv } from '../cli/env'
import { parseConfig } from '../config/load'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { randomUuids, sequentialIds } from '../ids'
import { reduceHarvest } from '../kernel/harvest'
import {
  artifactRef,
  harvestProposalKey,
  makeHarvestScanPacket,
  scanUnclaimedObservations,
} from './harvest'
import { ScriptedAgentRunner, defaultTurnResult, failedTurnResult } from '../ports/runner/fake'
import type { SessionStreamEmitter } from '../ports/types'
import { FakeTicketSource } from '../ports/tickets/fake'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import { HARVEST_PROPOSAL_LABEL, HarvestRunner } from './harvest-runner'

const mkdtemp = ownTempDirectories(afterEach)

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

async function seedObservation(
  store: MemoryBuildStore,
  build: string,
  summary: string,
): Promise<void> {
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
  policy: { maxReviewRounds?: number; stallRounds?: number; harvestMaxDrift?: number } = {},
  /** Extra `[tickets]` lines, e.g. `proposalState = "Ready"`. */
  tickets: string[] = [],
) {
  return parseConfig(
    [
      '[tickets]',
      'source = "file"',
      'readyState = "Ready"',
      ...tickets,
      '[roles.default]',
      'runtime = "scripted"',
      '[policy]',
      `harvestThreshold = ${threshold}`,
      `harvestMaxDrift = ${policy.harvestMaxDrift ?? 3}`,
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
      labels: [HARVEST_PROPOSAL_LABEL],
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
  test('samples the current harvest threshold instead of the constructor config', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-live-config-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedObservation(store, 'one', 'below the reloaded threshold')
    const scripted = new ScriptedAgentRunner({
      script: () => {
        throw new Error('a below-threshold run must not launch an agent')
      },
    })
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      getConfig: () => config(2),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids: sequentialIds(),
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance',
      opts: { heartbeatMs: 100_000 },
    }).run()

    expect(result).toEqual({ outcome: 'idle' })
    expect(scripted.sessions.size).toBe(0)
    expect(
      (await store.getRepoEvents('/repo')).some((event) => event.type === 'harvest.started'),
    ).toBe(false)
  })

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
              JSON.parse(await readFile(join(workspace, '.ab', 'findings.json'), 'utf8')),
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
              JSON.stringify([{ severity: 'important', summary: 'Make the title specific' }]),
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
    const reviewers = journals.filter((session) => session.opts.skill === 'ab-harvest-review')
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
    expect(state.latest?.trigger).toBe('count')
    expect(state.ledger).toHaveLength(2)
    expect(await tickets.get('fake-1')).toMatchObject({
      state: 'Triage',
      labels: [HARVEST_PROPOSAL_LABEL],
    })
    expect(tickets.claims).toEqual([])
    expect(await tickets.listReady({ state: 'Ready', labels: [HARVEST_PROPOSAL_LABEL] })).toEqual({
      tickets: [],
      diagnostics: [],
    })
    expect(await makeRunner().run()).toEqual({ outcome: 'idle' })

    await seedObservation(store, 'three', 'third')
    expect(await makeRunner().run()).toEqual({ outcome: 'idle' })
    await seedObservation(store, 'four', 'fourth')
    expect((await makeRunner().run()).outcome).toBe('completed')
    expect(await tickets.get('fake-2')).not.toBeNull()
  })

  test('drift below the count threshold claims the whole accumulation and records why', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-drift-'))
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
          const file = join(workspace, '.ab', 'submit.json')
          await writeFile(file, JSON.stringify(proposalSet(observations, 'Drift-triggered defect')))
          await submitHarvestProposals(deps, file)
        } else {
          const notes = join(workspace, '.ab', 'review.md')
          await writeFile(notes, 'approved\n')
          await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        }
        return defaultTurnResult('done')
      },
    })

    await seedObservation(store, 'origin', 'oldest')
    await store.createBuild({ slug: 'landed', repo: '/repo' })
    await store.append('landed', {
      actor: DISPATCHER,
      type: 'pr.merged',
      payload: { sha: 'abc123' },
    })
    await seedObservation(store, 'fresh', 'recorded after merge')
    const result = await new HarvestRunner({
      store,
      tickets,
      config: config(5, { harvestMaxDrift: 1 }),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance-drift',
      opts: { heartbeatMs: 100_000 },
    }).run()

    expect(result).toMatchObject({ outcome: 'completed', launch: 'started' })
    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.trigger).toBe('drift')
    expect(state.latest?.observations).toEqual([
      { build: 'fresh', seq: 1 },
      { build: 'origin', seq: 1 },
    ])
  })

  test('the idle gate evaluates pressure from digests without per-build history reads', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-flat-gate-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    // Several settled builds carrying observations — the accumulation the
    // pre-AUT-521 gate re-read in full on every idle evaluation.
    for (let index = 0; index < 5; index += 1) {
      const slug = `settled-${index}`
      await seedObservation(store, slug, `accumulated ${index}`)
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'build.completed',
        payload: { outcome: 'merged' },
      })
    }
    let getEventReads = 0
    const getEvents = store.getEvents.bind(store)
    store.getEvents = async (slug) => {
      getEventReads += 1
      return getEvents(slug)
    }
    const scripted = new ScriptedAgentRunner({
      script: () => {
        throw new Error('an idle gate must not launch an agent')
      },
    })
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(10),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids: sequentialIds(),
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance-flat',
      opts: { heartbeatMs: 100_000 },
    }).run()

    expect(result).toEqual({ outcome: 'idle' })
    // The flat-cost invariant: the below-threshold idle return performs no
    // per-build history reads, however many settled builds accumulate.
    expect(getEventReads).toBe(0)
    expect(scripted.sessions.size).toBe(0)
  })

  test('a claim landing in the gate-to-scan window makes the launch a benign idle return', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-window-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    await seedObservation(store, 'one', 'window observation')

    // The digest/journal read reports a triggered gate (threshold 1), but a
    // concurrent run claims every occurrence before the runner's fresh scan
    // — settlement landing in the window between the two reads.
    let digestsReads = 0
    const getDigests = store.getRepoBuildDigests.bind(store)
    store.getRepoBuildDigests = async (repo: string) => {
      const digests = await getDigests(repo)
      digestsReads += 1
      if (digestsReads === 1) {
        await store.appendRepoWithArtifacts(
          '/repo',
          [{ kind: 'harvest-scan', content: '{}' }],
          (deposited) => ({
            actor: KERNEL,
            type: 'harvest.started',
            payload: {
              run: 'h_window',
              observations: [{ build: 'one', seq: 1 }],
              scan: artifactRef(deposited[0]!),
            },
          }),
        )
        await store.appendRepo('/repo', {
          actor: KERNEL,
          type: 'harvest.completed',
          payload: {
            run: 'h_window',
            dispositions: [
              {
                occurrence: { build: 'one', seq: 1 },
                action: 'suppressed',
                reason: 'settled in the gate-to-scan window',
              },
            ],
            report: { kind: 'harvest-report', rev: 0 },
          },
        })
      }
      return digests
    }

    const scripted = new ScriptedAgentRunner({
      script: () => {
        throw new Error('an emptied window must not launch an agent')
      },
    })
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids: sequentialIds(),
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance-window',
      opts: { heartbeatMs: 100_000 },
    }).run()

    // The re-confirmed gate sees an empty unclaimed set and returns idle —
    // no empty-packet validation throw escaping as a runner failure.
    expect(result).toEqual({ outcome: 'idle' })
    expect(scripted.sessions.size).toBe(0)
    const events = await store.getRepoEvents('/repo')
    // The only harvest.started is the window claim itself; the runner
    // appended no run of its own.
    expect(events.filter((event) => event.type === 'harvest.started')).toHaveLength(1)
  })

  for (const pauseDuring of ['synthesize', 'review'] as const) {
    test(`pauses after the in-flight ${pauseDuring} boundary and resumes without repeating completed work`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), `ab-harvest-pause-${pauseDuring}-`))
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
      expect(afterResumeEvents.filter((event) => event.type === 'harvest.started')).toHaveLength(1)
      expect(
        afterResumeEvents.filter((event) => event.type === 'harvest.proposals.submitted'),
      ).toHaveLength(1)
      expect(
        afterResumeEvents.filter((event) => event.type === 'harvest.review.verdict'),
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

  test('proposalState files an approved proposal there instead of triage', async () => {
    // Filing state is configuration, not a constant: a repository may waive the
    // grooming gate by pointing it at readyState, and the filed proposal then
    // satisfies the readiness gate the next tick reads.
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-proposal-state-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    const seeded = await seedOpenRun({ store, tickets, ids, workspace, stage: 'reviewed' })
    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('an approved run files without another agent')
      },
    })

    expect(
      await new HarvestRunner({
        store,
        tickets,
        config: config(1, {}, ['proposalState = "Ready"']),
        runtimes: { scripted: { runner: neverRun, servesModels: [''] } },
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: randomUuids(),
        clock: steppingClock(),
        instance: ids('instance'),
        opts: { heartbeatMs: 100_000 },
      }).run(),
    ).toEqual({ outcome: 'completed', launch: 'resumed', run: seeded.run })

    expect(await tickets.get('fake-1')).toMatchObject({
      state: 'Ready',
      labels: [HARVEST_PROPOSAL_LABEL],
    })
    // Still only proposed: the harvester never claims what it files.
    expect(tickets.claims).toEqual([])
    const ready = await tickets.listReady({ state: 'Ready', labels: [HARVEST_PROPOSAL_LABEL] })
    expect(ready.tickets.map((ticket) => ticket.ref.id)).toEqual(['fake-1'])
  })

  test('files validated deduplicated blockers on an approved create', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-blockers-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    tickets.add({
      revision: 'fixture',
      ref: { source: 'fake', id: 'fake-8' },
      title: 'Prerequisite',
      body: 'body',
      state: 'Ready',
      resolved: false,
      labels: [],
    })
    const ids = sequentialIds()
    const seeded = await seedOpenRun({
      store,
      tickets,
      ids,
      workspace,
      stage: 'reviewed',
      makeProposals: (observations) => {
        const set = proposalSet(observations)
        return {
          proposals: [{ ...set.proposals[0]!, blockedBy: ['fake-8', 'fake-8'] }],
        }
      },
    })
    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('an approved run files without another agent')
      },
    })

    await new HarvestRunner({
      store,
      tickets,
      config: config(1, {}, ['proposalState = "Ready"']),
      runtimes: { scripted: { runner: neverRun, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: ids('instance'),
      opts: { heartbeatMs: 100_000 },
    }).run()

    expect((await tickets.get('fake-1'))?.blockedBy).toEqual(['fake-8'])
    expect(tickets.dependencyQueries).toEqual([['fake-8']])
    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.run).toBe(seeded.run)
    expect(state.latest?.filed[0]?.blockers).toEqual({ declared: ['fake-8'], derived: [] })
  })

  test('refreshes observation origins at filing and records derived provenance in the report', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-origin-blocker-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const origin = {
      revision: 'fixture',
      ref: { source: 'fake', id: 'origin-1' },
      title: 'Originating work',
      body: 'body',
      state: 'Done',
      resolved: true,
      labels: [],
    }
    const tickets = new FakeTicketSource([origin])
    await store.createBuild({
      slug: 'resume-reviewed',
      repo: '/repo',
      ticket: origin.ref,
    })
    const ids = sequentialIds()
    const seeded = await seedOpenRun({
      store,
      tickets,
      ids,
      workspace,
      stage: 'reviewed',
    })
    // The scan saw a resolved origin. Filing is authoritative and must observe
    // that the ticket became unresolved while agents were working.
    await tickets.transition('origin-1', 'Doing')
    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('an approved run files without another agent')
      },
    })

    await new HarvestRunner({
      store,
      tickets,
      config: config(1, {}, ['proposalState = "Ready"']),
      runtimes: { scripted: { runner: neverRun, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: ids('instance'),
      opts: { heartbeatMs: 100_000 },
    }).run()

    expect((await tickets.get('fake-1'))?.blockedBy).toEqual(['origin-1'])
    expect(tickets.dependencyQueries).toEqual([['origin-1'], ['origin-1']])
    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.run).toBe(seeded.run)
    expect(state.latest?.filed[0]?.blockers).toEqual({
      declared: [],
      derived: ['origin-1'],
    })
    const reportRef = state.latest?.report
    expect(reportRef).toBeDefined()
    const report = await store.getRepoArtifact('/repo', reportRef!.kind, reportRef!.rev)
    expect(JSON.parse(new TextDecoder().decode(report!.content)).proposals[0].blockers).toEqual({
      declared: [],
      derived: ['origin-1'],
    })
  })

  test('an origin resolved before filing is not added as a blocker', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-resolved-origin-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const origin = {
      revision: 'fixture',
      ref: { source: 'fake', id: 'origin-1' },
      title: 'Originating work',
      body: 'body',
      state: 'Doing',
      resolved: false,
      labels: [],
    }
    const tickets = new FakeTicketSource([origin])
    await store.createBuild({ slug: 'resume-reviewed', repo: '/repo', ticket: origin.ref })
    const ids = sequentialIds()
    await seedOpenRun({ store, tickets, ids, workspace, stage: 'reviewed' })
    await tickets.transition('origin-1', 'Done')
    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('an approved run files without another agent')
      },
    })

    await new HarvestRunner({
      store,
      tickets,
      config: config(1),
      runtimes: { scripted: { runner: neverRun, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: ids('instance'),
      opts: { heartbeatMs: 100_000 },
    }).run()

    expect((await tickets.get('fake-1'))?.blockedBy).toBeUndefined()
    expect(reduceHarvest(await store.getRepoEvents('/repo')).latest?.filed[0]?.blockers).toEqual({
      declared: [],
      derived: [],
    })
  })

  test('an unknown blocker fails before reservation, create, or filing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-invalid-blocker-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    const uuids = countingUuids()
    const seeded = await seedOpenRun({
      store,
      tickets,
      ids,
      workspace,
      stage: 'reviewed',
      makeProposals: (observations) => {
        const set = proposalSet(observations)
        return { proposals: [{ ...set.proposals[0]!, blockedBy: ['fake-404'] }] }
      },
    })
    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('an approved run files without another agent')
      },
    })

    expect(
      await new HarvestRunner({
        store,
        tickets,
        config: config(1, {}, ['proposalState = "Ready"']),
        runtimes: { scripted: { runner: neverRun, servesModels: [''] } },
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: uuids.source,
        clock: steppingClock(),
        instance: ids('instance'),
        opts: { heartbeatMs: 100_000 },
      }).run(),
    ).toEqual({ outcome: 'failed', launch: 'resumed', run: seeded.run })

    expect(uuids.allocated).toEqual([])
    expect(await tickets.get('fake-1')).toBeNull()
    const events = await store.getRepoEvents('/repo')
    expect(events.some((event) => event.type === 'harvest.proposal.id-reserved')).toBe(false)
    expect(events.some((event) => event.type === 'harvest.proposal.filed')).toBe(false)
    expect(reduceHarvest(events).latest?.failure?.error).toContain('fake-404')
  })

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
      expect(reduceHarvest(await store.getRepoEvents('/repo')).latest?.status).toBe('completed')
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
    expect(events.filter((event) => event.type === 'harvest.recovery-requested')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'harvest.resumed')).toHaveLength(1)
    expect(reduceHarvest(events).latest?.recoveryRequests).toEqual([
      expect.objectContaining({
        attempt: 1,
        acknowledgedSeq: expect.any(Number),
      }),
    ])
  })

  test('recovers a shadowed historical file failure without repeating completed work', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-shadowed-file-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    let creates = 0
    class CountingTickets extends FakeTicketSource {
      override async create(...args: Parameters<FakeTicketSource['create']>) {
        creates += 1
        return super.create(...args)
      }
    }
    const tickets = new CountingTickets()
    const ids = sequentialIds()
    const seeded = await seedOpenRun({
      store,
      tickets,
      ids,
      workspace,
      stage: 'filed',
    })
    const reservation = crypto.randomUUID()
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.proposal.id-reserved',
      payload: {
        run: seeded.run,
        proposalKey: harvestProposalKey(seeded.proposals.proposals[0]!),
        id: reservation,
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.failed',
      payload: {
        run: seeded.run,
        step: 'file',
        attempt: 2,
        error: 'historical file failure',
        willRetry: false,
      },
    })
    const before = reduceHarvest(await store.getRepoEvents('/repo')).runs.find(
      (run) => run.run === seeded.run,
    )!
    const preserved = structuredClone({
      scan: before.scan,
      proposals: before.proposals,
      reviews: before.reviews,
      reservations: before.reservations,
      filed: before.filed,
    })

    // This later terminal run is the historical shape that used to hide the
    // parked file boundary from every control/status path.
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.started',
      payload: {
        run: 'h_later_completed',
        observations: [{ build: 'later', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 99 },
      },
    })
    await store.appendRepo('/repo', {
      actor: KERNEL,
      type: 'harvest.completed',
      payload: {
        run: 'h_later_completed',
        dispositions: [
          {
            occurrence: { build: 'later', seq: 1 },
            action: 'suppressed',
            proposalKey: 'later-suppressed',
          },
        ],
        report: { kind: 'harvest-report', rev: 99 },
      },
    })
    await seedObservation(store, 'fresh-pending', 'must wait for old recovery')

    const neverRun = new ScriptedAgentRunner({
      script: () => {
        throw new Error('approved shadowed recovery must not start an agent')
      },
    })
    expect(
      await new HarvestRunner({
        store,
        tickets,
        config: config(1),
        runtimes: { scripted: { runner: neverRun, servesModels: [''] } },
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: randomUuids(),
        clock: steppingClock(),
        instance: 'shadowed-file-recovery',
        opts: { heartbeatMs: 100_000 },
      }).run(),
    ).toEqual({ outcome: 'completed', launch: 'resumed', run: seeded.run })

    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    const recovered = state.runs.find((run) => run.run === seeded.run)!
    expect(recovered).toMatchObject({
      status: 'completed',
      recoveryRequests: [{ attempt: 1, limit: 2, acknowledgedSeq: expect.any(Number) }],
    })
    expect({
      scan: recovered.scan,
      proposals: recovered.proposals,
      reviews: recovered.reviews,
      reservations: recovered.reservations,
      filed: recovered.filed,
    }).toEqual(preserved)
    expect(state.runs.find((run) => run.run === 'h_later_completed')?.status).toBe('completed')
    expect(
      (await store.getRepoEvents('/repo')).filter((event) => event.type === 'harvest.started'),
    ).toHaveLength(2)
    expect(
      (await scanUnclaimedObservations(store, '/repo')).observations.map(
        (observation) => observation.occurrence.build,
      ),
    ).toEqual(['fresh-pending'])
    expect(creates).toBe(1)
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
    expect(events.filter((event) => event.type === 'harvest.proposals.submitted')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'harvest.recovery-requested')).toHaveLength(1)
  })

  test('a held repository lease excludes a duplicate launch', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-held-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    expect(await store.claimRepoLease('/repo', 'other-dispatcher', 3_600_000)).toBe(true)
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

  test('a loop-held lease is adopted: harvest heartbeats the holder and never claims or releases', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-adopt-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.ensureRepo('/repo')
    expect(await store.claimRepoLease('/repo', 'dispatch-run-1', 3_600_000)).toBe(true)
    const originalHeartbeat = store.heartbeatRepo.bind(store)
    const beats: string[] = []
    store.heartbeatRepo = async (repo, holder, ...rest) => {
      beats.push(holder)
      return originalHeartbeat(repo, holder, ...rest)
    }
    let claims = 0
    const originalClaim = store.claimRepoLease.bind(store)
    store.claimRepoLease = async (...args) => {
      claims += 1
      return originalClaim(...args)
    }
    await seedObservation(store, 'adopted', 'the owning loop launched this harvest')

    const scripted = new ScriptedAgentRunner({
      script: () => defaultTurnResult('done'),
    })
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids: sequentialIds(),
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'harvest-child',
      opts: { heartbeatMs: 100_000 },
      // The owning DispatchLoop holds the repository lease for its lifetime;
      // the HarvestRunner must adopt it, never contend for it.
      leaseHolder: 'dispatch-run-1',
    }).run()

    // The harvest ran to its agent boundary despite the held lease: it
    // adopted the holder instead of contending (a contender returns 'held'
    // without launching anything).
    expect(result.outcome).not.toBe('held')
    // No claim contended for the holder's lease.
    expect(claims).toBe(0)
    // Every beat named the holder, not the harvest's own instance.
    expect(beats).not.toContain('harvest-child')
    expect(beats.length).toBeGreaterThan(0)
    // The holder's lease survives the harvest: held by dispatch-run-1.
    expect((await store.getRepo('/repo'))?.lease?.holder).toBe('dispatch-run-1')
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
      (await store.getRepoEvents('/repo')).some((event) => event.type === 'harvest.failed'),
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
      exhaustedEvents.filter((event) => event.type === 'harvest.recovery-requested'),
    ).toHaveLength(2)
    expect(
      exhaustedEvents.filter((event) => event.type === 'harvest.recovery-exhausted'),
    ).toHaveLength(1)
    expect(calls).toBe(4)
    expect(await makeRunner('attention-barrier').run()).toEqual({
      outcome: 'parked',
      run: 'harvest_1',
    })
    expect(calls).toBe(4)
  })

  test('Harvest substitutes eligible failures per session and resets to primary for review', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-alternates-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        if (opts.model === 'primary-model') {
          return failedTurnResult('primary unavailable', false, '', 'availability')
        }
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const file = join(workspace, '.ab', 'alternate-proposals.json')
          await writeFile(file, JSON.stringify(proposalSet(observations)))
          await submitHarvestProposals(deps, file)
        } else {
          const notes = join(workspace, '.ab', 'alternate-review.md')
          await writeFile(notes, 'approved by alternate\n')
          await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        }
        return defaultTurnResult('done')
      },
    })
    const alternateConfig = parseConfig(`
[tickets]
source = "file"
readyState = "Ready"
[roles.default]
runtime = "scripted"
model = "primary-model"
args = ["--primary-flag"]
alternates = [{ runtime = "alternate", model = "alternate-model", args = [] }]
[policy]
harvestThreshold = 1
`)
    await seedObservation(store, 'alternate-provider', 'primary provider unavailable')

    expect(
      await new HarvestRunner({
        store,
        tickets,
        config: alternateConfig,
        runtimes: {
          scripted: { runner: scripted, servesModels: ['primary-'] },
          alternate: { runner: scripted, servesModels: ['alternate-'] },
        },
        repo: '/repo',
        workspacePath: workspace,
        ids,
        uuids: randomUuids(),
        clock: steppingClock(),
        instance: 'harvest-alternates',
        opts: { heartbeatMs: 100_000 },
      }).run(),
    ).toMatchObject({ outcome: 'completed' })

    const events = await store.getRepoEvents('/repo')
    const starts = events.filter((event) => event.type === 'harvest.session.started')
    expect(starts.map((event) => event.payload.runner)).toEqual([
      'scripted',
      'alternate',
      'scripted',
      'alternate',
    ])
    expect(starts.map((event) => event.payload.args)).toEqual([
      ['--primary-flag'],
      [],
      ['--primary-flag'],
      [],
    ])
    expect(starts[1]?.payload).toMatchObject({
      substitution: {
        failed: { index: 0, error: 'primary unavailable', cause: 'availability' },
        selectedIndex: 1,
      },
    })
    expect(events.filter((event) => event.type === 'harvest.failed')).toHaveLength(0)
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
    expect(events.filter((event) => event.type === 'harvest.session.started')).toHaveLength(1)
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
      recoveryRequests: [{ attempt: 1, limit: 2, acknowledgedSeq: expect.any(Number) }],
    })
    expect(repairedEvents.filter((event) => event.type === 'harvest.started')).toHaveLength(1)
    expect(
      repairedEvents.filter((event) => event.type === 'harvest.proposals.submitted'),
    ).toHaveLength(1)
    expect(repairedEvents.filter((event) => event.type === 'harvest.review.verdict')).toHaveLength(
      1,
    )
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
                ...(previousFinding === undefined ? {} : { persists: [previousFinding] }),
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
        const reservation = current?.reservations.find((entry) => entry.id === reservedId)
        expect(reservation).toBeDefined()
        expect(current?.filed.some((entry) => entry.proposalKey === reservation?.proposalKey)).toBe(
          false,
        )
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
    const reservations = events.filter((event) => event.type === 'harvest.proposal.id-reserved')
    const filings = events.filter((event) => event.type === 'harvest.proposal.filed')
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
    expect(createTitles).toEqual(['Harvested defect 1', 'Harvested defect 2', 'Harvested defect 2'])
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
      recoveryRequests: [{ attempt: 1, limit: 2, acknowledgedSeq: expect.any(Number) }],
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
    expect(events.filter((event) => event.type === 'harvest.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'harvest.proposals.submitted')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'harvest.review.verdict')).toHaveLength(1)
    const filings = events.filter((event) => event.type === 'harvest.proposal.filed')
    expect(filings).toHaveLength(2)
    expect(new Set(filings.map((event) => event.payload.proposalKey)).size).toBe(2)
    expect(events.filter((event) => event.type === 'harvest.completed')).toHaveLength(1)
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
        releasedObservations: scan.observations.map((item) => item.occurrence),
        pendingProposals: [
          {
            proposalKey: harvestProposalKey(proposal),
            action: 'join',
          },
        ],
      },
    })
    expect(events.filter((event) => event.type === 'harvest.recovery-exhausted')).toHaveLength(1)
    expect(
      (await scanUnclaimedObservations(store, '/repo')).observations.map((item) => item.occurrence),
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
    expect(await tickets.get('fake-1')).toMatchObject({
      labels: [HARVEST_PROPOSAL_LABEL],
    })
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

describe('HarvestRunner hosted provenance', () => {
  test('a hosted guest stamps its environment into harvest.started', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-hosted-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    // The adopting dispatch loop holds the repository lease; the guest
    // heartbeats it and never releases it.
    await store.ensureRepo('/repo')
    await store.claimRepoLease('/repo', 'host-dispatch-i0', 60_000)
    await seedObservation(store, 'hosted', 'hosted provenance boundary')
    const scripted = new ScriptedAgentRunner({
      script: () => {
        throw new Error('a provenance check must not reach an agent turn')
      },
    })
    const environment = {
      provider: 'vercel-sandbox',
      environmentId: 'autobuild-harvest-abc1234567',
      sessionId: 'session-1',
    }
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids: sequentialIds(),
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'guest-i1',
      leaseHolder: 'host-dispatch-i0',
      environment,
      opts: { heartbeatMs: 100_000 },
    }).run()

    expect(result.outcome).toBe('failed')
    const started = (await store.getRepoEvents('/repo')).find(
      (event) => event.type === 'harvest.started',
    )
    expect(started?.payload.environment).toEqual(environment)
    // The adopted lease is deliberately left held for the owning loop.
    expect((await store.getRepo('/repo'))?.lease?.holder).toBe('host-dispatch-i0')
  })
})

// ── Session streams (SPEC §9) ────────────────────────────────────────────────

describe('HarvestRunner session streams (SPEC §9)', () => {
  type StreamScript = NonNullable<ConstructorParameters<typeof ScriptedAgentRunner>[0]['script']>

  /** Default single-round happy path: producer submits, reviewer approves.
   * Every turn first appends a probe part through its per-turn emitter —
   * the wiring under test. */
  function happyScript(
    workspace: string,
    deps: { store: MemoryBuildStore; ids: ReturnType<typeof sequentialIds> },
  ): StreamScript {
    return async ({ opts, turn }) => {
      opts.stream?.append([{ type: 'data-ab-prompt', data: { text: `${opts.skill}@${turn}` } }])
      const env = resolveHarvestCliEnv(opts.env)
      const ctx = { store: deps.store, env, workspacePath: workspace, ids: deps.ids }
      await buildHarvestContext(ctx)
      if (opts.skill === 'ab-harvest') {
        const observations = JSON.parse(
          await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
        ) as Array<{ occurrence: { build: string; seq: number } }>
        const file = join(workspace, '.ab', `proposals-${turn}.json`)
        await writeFile(file, JSON.stringify(proposalSet(observations)))
        await submitHarvestProposals(ctx, file)
      } else {
        const notes = join(workspace, '.ab', 'review.md')
        await writeFile(notes, 'approved\n')
        await submitHarvestVerdict(ctx, { verdict: 'approve', notes })
      }
      return defaultTurnResult('done')
    }
  }

  for (const step of ['synthesize', 'review'] as const) {
    for (const failure of ['start', 'cleanup'] as const) {
      test(`${step} ${failure} failure closes the bracket and retries without crash recovery`, async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-failed-bracket-'))
        roots.push(workspace)
        const store = new MemoryBuildStore({ clock: steppingClock() })
        const tickets = new FakeTicketSource()
        const ids = sequentialIds()
        const seeded = await seedOpenRun({
          store,
          tickets,
          ids,
          workspace,
          stage: step === 'synthesize' ? 'started' : 'proposals',
        })
        let fail = true
        let failedHandle: string | undefined
        const happy = happyScript(workspace, { store, ids })
        const scripted = new ScriptedAgentRunner({
          nativeState: new Map(),
          script: async (ctx) => {
            if (failure === 'cleanup' && fail && ctx.opts.env.AB_PHASE === `${step}@1`) {
              fail = false
              failedHandle = ctx.session.id
              return failedTurnResult('provider temporarily unavailable', false)
            }
            return happy(ctx)
          },
        })
        const start = scripted.start.bind(scripted)
        scripted.start = async (opts) => {
          if (failure === 'start' && fail && opts.env.AB_PHASE === `${step}@1`) {
            fail = false
            throw new Error('spawn ENOENT')
          }
          return start(opts)
        }
        const end = scripted.end.bind(scripted)
        scripted.end = async (session) => {
          if (session.id === failedHandle) throw new Error('adapter transcript unavailable')
          return end(session)
        }
        const run = (instance: string) =>
          new HarvestRunner({
            store,
            tickets,
            config: config(1),
            runtimes: {
              scripted: {
                runner: scripted,
                servesModels: [''],
                openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
              },
            },
            repo: '/repo',
            workspacePath: workspace,
            ids,
            uuids: randomUuids(),
            clock: steppingClock(),
            instance,
            opts: { heartbeatMs: 100_000, maxSessionAttempts: 2, maxRecoveryAttempts: 1 },
          }).run()

        expect((await run('first')).outcome).toBe('failed')
        const first = await store.getRepoEvents('/repo')
        const started = first.find((event) => event.type === 'harvest.session.started')!
        const ended = first.find((event) => event.type === 'harvest.session.ended')!
        const failed = first.find((event) => event.type === 'harvest.failed')!
        expect(ended?.payload.session).toBe(started.payload.session)
        expect(ended.seq).toBeLessThan(failed.seq)
        expect(ended.payload.usage).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          turns: failure === 'start' ? 0 : 1,
        })
        expect(failed.payload).toMatchObject({
          run: seeded.run,
          step,
          round: 1,
          attempt: 1,
          error: failure === 'start' ? 'spawn ENOENT' : 'provider temporarily unavailable',
          willRetry: true,
        })
        expect(reduceHarvest(first).latest?.sessions.at(-1)?.status).toBe('ended')
        const transcript = await store.getRepoArtifact(
          '/repo',
          ended.payload.transcript.kind,
          ended.payload.transcript.rev,
        )
        expect(new TextDecoder().decode(transcript!.content)).toContain(
          failure === 'start' ? 'spawn ENOENT' : 'adapter transcript unavailable',
        )
        expect(await store.getStream(started.payload.stream!)).toMatchObject({
          status: 'closed',
          outcome: 'aborted',
        })

        expect((await run('replacement')).outcome).toBe('completed')
        const events = await store.getRepoEvents('/repo')
        expect(events.filter((event) => event.type === 'harvest.failed')).toHaveLength(1)
        expect(
          events.some(
            (event) =>
              event.type === 'harvest.recovery-requested' ||
              event.type === 'harvest.session.resume-fallback' ||
              event.type === 'harvest.session.resumed',
          ),
        ).toBe(false)
        expect(
          events
            .filter((event) => event.type === 'harvest.session.started')
            .every((event) => event.payload.continuation === undefined),
        ).toBe(true)
        expect(events.filter((event) => event.type === 'harvest.proposal.filed')).toHaveLength(1)
      })
    }
  }

  test('failed-session transcript persistence errors do not record an ordinary provider failure', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-failed-deposit-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    await seedOpenRun({ store, tickets, ids, workspace, stage: 'started' })
    const append = store.appendRepoWithArtifacts.bind(store)
    store.appendRepoWithArtifacts = async (...args) => {
      if (args[1].some((artifact) => artifact.kind === 'harvest-transcript')) {
        throw new Error('transcript store unavailable')
      }
      return append(...args)
    }
    const scripted = new ScriptedAgentRunner({
      script: () => {
        throw new Error('spawn ENOENT')
      },
    })
    const runner = new HarvestRunner({
      store,
      tickets,
      config: config(1),
      runtimes: {
        scripted: {
          runner: scripted,
          servesModels: [''],
          openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
        },
      },
      repo: '/repo',
      workspacePath: workspace,
      ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'failed-deposit',
    })
    await expect(runner.run()).rejects.toThrow(
      'Harvest failed-session transcript persistence failed',
    )
    const events = await store.getRepoEvents('/repo')
    expect(events.some((event) => event.type === 'harvest.failed')).toBe(false)
    expect(events.some((event) => event.type === 'harvest.session.ended')).toBe(false)
    expect(reduceHarvest(events).latest?.sessions.at(-1)?.status).toBe('open')
    expect(await store.listStreams({ kind: 'repo', repo: '/repo' })).toMatchObject([
      { status: 'closed', outcome: 'aborted' },
    ])
  })

  function startedSessionEvents(events: Awaited<ReturnType<MemoryBuildStore['getRepoEvents']>>) {
    return events.filter((event) => event.type === 'harvest.session.started')
  }

  /** The finalized document of a closed stream. The memory store prunes
   * older closed streams' chunks as newer ones open (the content lives in
   * the artifact), so closed-stream assertions read the artifact. */
  async function promptTexts(store: MemoryBuildStore, streamId: string): Promise<string[]> {
    const artifact = await store.getRepoArtifact('/repo', `stream:${streamId}`)
    expect(artifact).not.toBeNull()
    const document = JSON.parse(new TextDecoder().decode(artifact!.content)) as Array<{
      parts: Array<{ type: string; data?: { text?: string } }>
    }>
    return document
      .flatMap((entry) => entry.parts)
      .filter((part) => part.type === 'data-ab-prompt')
      .map((part) => part.data!.text!)
  }

  test('a streaming registration opens one stream per bracket, names it on harvest.session.started, and passes the emitter into the turn', async () => {
    const workspacePromise = mkdtemp(join(tmpdir(), 'ab-harvest-streams-'))
    roots.push(await workspacePromise)
    const workspace = await workspacePromise
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const deps = { store, ids: sequentialIds() }
    const opened: string[] = []
    const diagnostics: string[] = []
    const scripted = new ScriptedAgentRunner({ script: happyScript(workspace, deps) })
    await seedObservation(store, 'one', 'first')
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: {
        scripted: {
          runner: scripted,
          servesModels: [''],
          openSessionStream: async (sink, info) => {
            opened.push(info.session)
            return sink.open(`session:${info.session}`)
          },
        },
      },
      repo: '/repo',
      workspacePath: workspace,
      ids: deps.ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance',
      opts: { heartbeatMs: 100_000, onDiagnostic: (message) => diagnostics.push(message) },
    }).run()
    expect(result.outcome).toBe('completed')
    expect(diagnostics).toEqual([])

    const events = await store.getRepoEvents('/repo')
    const started = startedSessionEvents(events)
    expect(started).toHaveLength(2)
    expect(started.every((event) => typeof event.payload.stream === 'string')).toBe(true)
    expect(opened).toHaveLength(2)
    const streams = await store.listStreams({ kind: 'repo', repo: '/repo' })
    expect(streams).toHaveLength(2)
    expect(new Set(started.map((event) => event.payload.stream!))).toEqual(
      new Set(streams.map((record) => record.id)),
    )
    // Every stream: first part data-ab-session with the bracket identity,
    // closed completed, finalized document assembled from the appended
    // parts, artifact landed on the repo scope.
    for (const event of started) {
      const record = streams.find((candidate) => candidate.id === event.payload.stream)
      expect(record).toBeDefined()
      expect(record!.status).toBe('closed')
      expect(record!.outcome).toBe('completed')
      expect(record!.label).toBe(`session:${event.payload.session}`)
      const artifact = await store.getRepoArtifact('/repo', `stream:${record!.id}`)
      expect(artifact).not.toBeNull()
      const document = JSON.parse(new TextDecoder().decode(artifact!.content))
      expect(document[0]?.parts?.[0]?.type).toBe('data-ab-session')
      const first = document[0].parts[0] as { data: Record<string, unknown> }
      expect(first.data).toMatchObject({
        session: event.payload.session,
        role: event.payload.role,
        runner: event.payload.runner,
        phase: `harvest:${event.payload.step}`,
        round: event.payload.round,
      })
      // The turn's probe part arrived through the per-turn emitter.
      expect(await promptTexts(store, record!.id)).toEqual([
        `${event.payload.role === 'harvest' ? 'ab-harvest' : 'ab-harvest-review'}@1`,
      ])
    }
  })

  test("a continued producer round streams into its own bracket, not the start turn's stream", async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-stream-cont-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    const opened: string[] = []
    const diagnostics: string[] = []
    const emitters: Array<SessionStreamEmitter | undefined> = []
    let reviewRound = 0
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts, turn }) => {
        emitters.push(opts.stream)
        opts.stream?.append([{ type: 'data-ab-prompt', data: { text: `${opts.skill}@${turn}` } }])
        const env = resolveHarvestCliEnv(opts.env)
        const ctx = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(ctx)
        if (opts.skill === 'ab-harvest') {
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
          await submitHarvestProposals(ctx, file)
        } else {
          reviewRound += 1
          const notes = join(workspace, '.ab', `review-${reviewRound}.md`)
          await writeFile(notes, reviewRound === 1 ? 'revise' : 'approve')
          if (reviewRound === 1) {
            const findings = join(workspace, '.ab', 'review-findings.json')
            await writeFile(
              findings,
              JSON.stringify([{ severity: 'important', summary: 'Make the title specific' }]),
            )
            await submitHarvestVerdict(ctx, { verdict: 'revise', notes, findings })
          } else {
            await submitHarvestVerdict(ctx, { verdict: 'approve', notes })
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
      runtimes: {
        scripted: {
          runner: scripted,
          servesModels: [''],
          openSessionStream: async (sink, info) => {
            opened.push(info.session)
            return sink.open(`session:${info.session}`)
          },
        },
      },
      repo: '/repo',
      workspacePath: workspace,
      ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance',
      opts: { heartbeatMs: 100_000, onDiagnostic: (message) => diagnostics.push(message) },
    }).run()
    expect(result.outcome).toBe('completed')
    expect(diagnostics).toEqual([])

    // One continued producer session, two review sessions: four brackets,
    // four streams, each turn observed its own bracket's emitter.
    const journals = [...scripted.sessions.values()]
    const producers = journals.filter((session) => session.opts.skill === 'ab-harvest')
    expect(producers).toHaveLength(1)
    expect(producers[0]?.turns).toHaveLength(2)
    expect(emitters).toHaveLength(4)
    expect(emitters.every((emitter) => emitter !== undefined)).toBe(true)
    // The continued (round-2) turn observed a DIFFERENT emitter than round 1.
    expect(emitters[2]).not.toBe(emitters[0])
    expect(emitters[2]).not.toBe(emitters[1])

    const events = await store.getRepoEvents('/repo')
    const started = startedSessionEvents(events)
    expect(started).toHaveLength(4)
    const streams = await store.listStreams({ kind: 'repo', repo: '/repo' })
    expect(streams).toHaveLength(4)
    expect(new Set(streams.map((record) => record.id))).toEqual(
      new Set(started.map((event) => event.payload.stream!)),
    )
    for (const record of streams) {
      expect(record.status).toBe('closed')
      expect(record.outcome).toBe('completed')
    }
    // Round-1's stream closed at its deposit, before the continuation ran —
    // it carries only round-1's probe. Round-2's synthesize stream carries
    // only round-2's.
    const synStarted = started.filter((event) => event.payload.step === 'synthesize')
    expect(synStarted).toHaveLength(2)
    expect(await promptTexts(store, synStarted[0]!.payload.stream!)).toEqual(['ab-harvest@1'])
    expect(await promptTexts(store, synStarted[1]!.payload.stream!)).toEqual(['ab-harvest@2'])
  })

  test('a registration without the capability yields sessions with no stream and no emitter', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-stream-nocap-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const deps = { store, ids: sequentialIds() }
    const diagnostics: string[] = []
    const scripted = new ScriptedAgentRunner({ script: happyScript(workspace, deps) })
    await seedObservation(store, 'one', 'first')
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      repo: '/repo',
      workspacePath: workspace,
      ids: deps.ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance',
      opts: { heartbeatMs: 100_000, onDiagnostic: (message) => diagnostics.push(message) },
    }).run()
    expect(result.outcome).toBe('completed')
    expect(diagnostics).toEqual([])

    const events = await store.getRepoEvents('/repo')
    for (const event of startedSessionEvents(events)) {
      expect(event.payload.stream).toBeUndefined()
    }
    expect(await store.listStreams({ kind: 'repo', repo: '/repo' })).toHaveLength(0)
    // No emitter reached the turns either.
    for (const journal of scripted.sessions.values()) {
      expect(journal.opts.stream).toBeUndefined()
    }
  })

  test('streamSessions: false reproduces the no-stream event log', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-stream-off-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const deps = { store, ids: sequentialIds() }
    const diagnostics: string[] = []
    const scripted = new ScriptedAgentRunner({ script: happyScript(workspace, deps) })
    await seedObservation(store, 'one', 'first')
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: {
        scripted: {
          runner: scripted,
          servesModels: [''],
          openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
        },
      },
      repo: '/repo',
      workspacePath: workspace,
      ids: deps.ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance',
      opts: {
        heartbeatMs: 100_000,
        streamSessions: false,
        onDiagnostic: (message) => diagnostics.push(message),
      },
    }).run()
    expect(result.outcome).toBe('completed')
    expect(diagnostics).toEqual([])

    const events = await store.getRepoEvents('/repo')
    for (const event of startedSessionEvents(events)) {
      expect(event.payload.stream).toBeUndefined()
    }
    expect(await store.listStreams({ kind: 'repo', repo: '/repo' })).toHaveLength(0)
  })

  test('a store whose stream appends always fail lets the run complete with one diagnostic per bracket and aborted closes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-stream-fail-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const deps = { store, ids: sequentialIds() }
    const diagnostics: string[] = []
    const scripted = new ScriptedAgentRunner({ script: happyScript(workspace, deps) })
    await seedObservation(store, 'one', 'first')

    // Break the append primitive after the streams are created.
    const failing = new Set<string>()
    const originalAppend = store.appendStreamParts.bind(store)
    store.appendStreamParts = async (streamId: string, parts: never) => {
      if (failing.has(streamId)) throw new Error('store down')
      return originalAppend(streamId, parts)
    }
    const originalCreate = store.createStream.bind(store)
    store.createStream = async (scope: never, label: never) => {
      const record = await originalCreate(scope, label)
      failing.add(record.id)
      return record
    }

    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: {
        scripted: {
          runner: scripted,
          servesModels: [''],
          openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
        },
      },
      repo: '/repo',
      workspacePath: workspace,
      ids: deps.ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance',
      opts: { heartbeatMs: 100_000, onDiagnostic: (message) => diagnostics.push(message) },
    }).run()
    // The run completes exactly as it would without streams.
    expect(result.outcome).toBe('completed')
    // Each bracket's defunct writer reported once and closed aborted.
    expect(diagnostics).toHaveLength(2)
    const streams = await store.listStreams({ kind: 'repo', repo: '/repo' })
    expect(streams).toHaveLength(2)
    for (const record of streams) {
      expect(record.status).toBe('closed')
      expect(record.outcome).toBe('aborted')
    }
    // Transcripts were deposited regardless.
    const events = await store.getRepoEvents('/repo')
    const ended = events.filter((event) => event.type === 'harvest.session.ended')
    expect(ended).toHaveLength(2)
  })

  test('a bracket that ends without its terminal closes its stream aborted', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-stream-noterm-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const deps = { store, ids: sequentialIds() }
    const diagnostics: string[] = []
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        opts.stream?.append([{ type: 'data-ab-prompt', data: { text: 'no terminal here' } }])
        return defaultTurnResult('did nothing durable')
      },
    })
    await seedObservation(store, 'one', 'first')
    const result = await new HarvestRunner({
      store,
      tickets: new FakeTicketSource(),
      config: config(1),
      runtimes: {
        scripted: {
          runner: scripted,
          servesModels: [''],
          openSessionStream: async (sink, info) => sink.open(`session:${info.session}`),
        },
      },
      repo: '/repo',
      workspacePath: workspace,
      ids: deps.ids,
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'instance',
      opts: { heartbeatMs: 100_000, onDiagnostic: (message) => diagnostics.push(message) },
    }).run()
    expect(result.outcome).toBe('failed')
    expect(diagnostics).toEqual([])

    const streams = await store.listStreams({ kind: 'repo', repo: '/repo' })
    expect(streams).toHaveLength(1)
    expect(streams[0]!.status).toBe('closed')
    expect(streams[0]!.outcome).toBe('aborted')
    expect(await promptTexts(store, streams[0]!.id)).toEqual(['no terminal here'])
  })
})

test('resuming an approved join canonicalizes a legacy ledger target without changing its proposal key', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-alias-join-'))
  const store = new MemoryBuildStore({ clock: steppingClock() })
  const tickets = new FakeTicketSource([
    {
      revision: '1',
      ref: { source: 'fake', id: 'ENG-1' },
      title: 'Existing',
      body: 'Body',
      state: 'Triage',
      resolved: false,
      labels: [],
    },
  ])
  const get = tickets.get.bind(tickets)
  tickets.get = (id) => get(id === 'ticket-legacy' || id === 'eng-1' ? 'ENG-1' : id)
  try {
    await seedObservation(store, 'alias-origin', 'same defect')
    const scan = await scanUnclaimedObservations(store, '/repo')
    const run = 'h_alias_join'
    const packet = {
      repo: '/repo',
      run,
      observations: scan.observations,
      ledger: [
        {
          proposalKey: 'immutable-old-key',
          ticket: { source: 'fake', id: 'ticket-legacy' },
          exists: true,
          resolved: false,
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
          observations: scan.observations.map((o) => o.occurrence),
          scan: artifactRef(deposited[0]!),
        },
      }),
    )
    const proposal = {
      action: 'join',
      ticket: { source: 'fake', id: 'eng-1' },
      reason: 'Same defect',
      observations: scan.observations.map((o) => o.occurrence),
    }
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-proposals', content: JSON.stringify({ proposals: [proposal] }) }],
      (deposited) => ({
        actor: agentActor('harvest', 's'),
        type: 'harvest.proposals.submitted',
        payload: { run, round: 1, artifact: artifactRef(deposited[0]!) },
      }),
    )
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-review', content: 'approved' }],
      (deposited) => ({
        actor: agentActor('harvest-review', 'r'),
        type: 'harvest.review.verdict',
        payload: {
          run,
          round: 1,
          verdict: 'approve',
          findings: [],
          artifact: artifactRef(deposited[0]!),
        },
      }),
    )
    const before = await store.getRepoEvents('/repo')
    const runner = new HarvestRunner({
      store,
      tickets,
      config: config(1),
      runtimes: {
        scripted: {
          runner: new ScriptedAgentRunner({
            script: () => {
              throw new Error('approved file must resume without agents')
            },
          }),
          servesModels: [''],
        },
      },
      repo: '/repo',
      workspacePath: workspace,
      ids: sequentialIds(),
      uuids: randomUuids(),
      clock: steppingClock(),
      instance: 'alias-join',
      opts: { heartbeatMs: 100_000 },
    })
    expect(await runner.run()).toMatchObject({ outcome: 'completed', launch: 'resumed' })
    const after = await store.getRepoEvents('/repo')
    expect(after.slice(0, before.length)).toEqual(before)
    const completed = after.find((e) => e.type === 'harvest.completed')
    if (completed?.type !== 'harvest.completed') throw new Error('missing completion')
    expect(completed.payload.dispositions[0]).toMatchObject({
      action: 'joined',
      proposalKey: 'immutable-old-key',
      ticket: { id: 'ENG-1' },
    })
    expect((await tickets.listReady({})).tickets).toHaveLength(1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

describe('local harvest native suspension', () => {
  for (const step of ['synthesize', 'review', 'continue'] as const) {
    for (const native of [true, false]) {
      test(`${step}: repeated clean stops ${native ? 'resume native identity' : 'record fresh fallback'} without recovery`, async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-suspend-'))
        roots.push(workspace)
        const store = new MemoryBuildStore({ clock: steppingClock() })
        const tickets = new FakeTicketSource()
        const ids = sequentialIds()
        await seedObservation(store, 'suspension', 'retain this turn')
        const nativeState = native ? new Map<string, string[]>() : undefined
        const logicalSessions: string[] = []
        let stops = 0
        let stop = new AbortController()
        const deps = {
          store,
          tickets,
          config: config(1),
          repo: '/repo',
          workspacePath: workspace,
          ids,
          uuids: randomUuids(),
          clock: steppingClock(),
          opts: { heartbeatMs: 100_000, maxRecoveryAttempts: 1 },
        }
        const makeRunner = () =>
          new ScriptedAgentRunner({
            nativeState,
            script: async ({ opts, message }) => {
              const env = resolveHarvestCliEnv(opts.env)
              const cli = { store, env, workspacePath: workspace, ids }
              if (
                env.phase === step ||
                (step === 'continue' && env.phase === 'synthesize' && env.round === 2)
              ) {
                logicalSessions.push(env.session)
                if (stops++ < 3) {
                  stop.abort()
                  return defaultTurnResult('partial work')
                }
                if (native) expect(message).toContain('ab harvest context')
              }
              await buildHarvestContext(cli)
              if (env.phase === 'synthesize') {
                const observations = JSON.parse(
                  await readFile(join(workspace, '.ab/observations.json'), 'utf8'),
                )
                const file = join(workspace, '.ab/proposals.json')
                await writeFile(file, JSON.stringify(proposalSet(observations)))
                await submitHarvestProposals(cli, file)
              } else {
                const notes = join(workspace, '.ab/review.md')
                await writeFile(notes, 'approved')
                if (step === 'continue' && env.round === 1) {
                  const findings = join(workspace, '.ab/findings-input.json')
                  await writeFile(
                    findings,
                    JSON.stringify([{ severity: 'important', summary: 'Clarify the proposal' }]),
                  )
                  await submitHarvestVerdict(cli, { verdict: 'revise', notes, findings })
                } else await submitHarvestVerdict(cli, { verdict: 'approve', notes })
              }
              return defaultTurnResult('done')
            },
          })
        for (let generation = 0; generation < 4; generation++) {
          stop = new AbortController()
          const runner = makeRunner()
          const result = await new HarvestRunner({
            ...deps,
            instance: `generation-${generation}`,
            shutdownSignal: stop.signal,
            runtimes: { scripted: { runner, servesModels: [''] } },
          }).run()
          expect(result.outcome).toBe(generation < 3 ? 'suspended' : 'completed')
          const events = await store.getRepoEvents('/repo')
          expect(
            events.filter(
              (e) => e.type === 'harvest.failed' || e.type === 'harvest.recovery-requested',
            ),
          ).toHaveLength(0)
          const { readRepositoryFacts } = await import('../store/reduced-reads')
          const { projectHarvestStatus } = await import('../cli/harvest')
          const { projectHarvest } = await import('../cli/dashboard/model')
          const facts = (await readRepositoryFacts(store, '/repo')).value
          expect(projectHarvestStatus('/repo', facts)).toEqual(
            projectHarvestStatus('/repo', events),
          )
          if (generation < 3) {
            expect(projectHarvestStatus('/repo', facts).status).toBe('suspended')
            expect(projectHarvest(events)?.status).toBe('suspended')
            expect(projectHarvest(events)?.action).toBeUndefined()
            const paused = projectHarvest([
              ...events,
              {
                repo: '/repo',
                actor: KERNEL,
                type: 'harvest.paused',
                payload: {},
                seq: events.at(-1)!.seq + 1,
                ts: '2099-01-01T00:00:00Z',
              },
            ])
            expect(paused?.steps).toEqual(projectHarvest(events)?.steps)
            const bracket = facts.harvest.runs[0]!.sessions.at(-1)!
            expect(bracket.status).toBe('suspended')
            expect(bracket.transcript).toBeDefined()
            if (native) expect(bracket.nativeHandle?.nativeId).toBeDefined()
          }
        }
        const events = await store.getRepoEvents('/repo')
        expect(new Set(logicalSessions).size).toBe(4)
        expect(events.filter((e) => e.type === 'harvest.session.suspended')).toHaveLength(3)
        expect(
          events.filter(
            (e) =>
              e.type === (native ? 'harvest.session.resumed' : 'harvest.session.resume-fallback'),
          ),
        ).toHaveLength(3)
        expect(events.filter((e) => e.type === 'harvest.proposal.filed')).toHaveLength(1)
        if (native) {
          const accepted = events.filter((e) => e.type === 'harvest.session.resumed')
          expect(new Set(accepted.map((e) => e.payload.handle.nativeId)).size).toBe(1)
        }
      })
    }
  }

  test('a durable terminal wins an abort and stops before launching review', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-terminal-stop-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedObservation(store, 'terminal', 'terminal wins')
    const ids = sequentialIds()
    const stop = new AbortController()
    const runner = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        const cli = { store, env: resolveHarvestCliEnv(opts.env), workspacePath: workspace, ids }
        await buildHarvestContext(cli)
        const observations = JSON.parse(
          await readFile(join(workspace, '.ab/observations.json'), 'utf8'),
        )
        const file = join(workspace, '.ab/proposals.json')
        await writeFile(file, JSON.stringify(proposalSet(observations)))
        await submitHarvestProposals(cli, file)
        stop.abort()
        throw new Error('abort after typed terminal')
      },
    })
    expect(
      (
        await new HarvestRunner({
          store,
          tickets: new FakeTicketSource(),
          config: config(1),
          runtimes: { scripted: { runner, servesModels: [''] } },
          repo: '/repo',
          workspacePath: workspace,
          ids,
          uuids: randomUuids(),
          clock: steppingClock(),
          instance: 'terminal',
          shutdownSignal: stop.signal,
        }).run()
      ).outcome,
    ).toBe('suspended')
    const events = await store.getRepoEvents('/repo')
    expect(
      events.filter((e) => e.type === 'harvest.session.suspended' || e.type === 'harvest.failed'),
    ).toHaveLength(0)
    expect(events.filter((e) => e.type === 'harvest.session.started')).toHaveLength(1)
    expect(
      events.some((e) => e.type === 'harvest.step.completed' && e.payload.step === 'synthesize'),
    ).toBe(true)
  })
})

test('a resumed alternate sharing the primary runner is not retained as the primary producer', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-alternate-producer-'))
  roots.push(workspace)
  const store = new MemoryBuildStore({ clock: steppingClock() })
  const tickets = new FakeTicketSource()
  const ids = sequentialIds()
  const { run } = await seedOpenRun({ store, tickets, ids, workspace, stage: 'started' })
  await store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'harvest.step.started',
    payload: { run, step: 'synthesize', round: 1 },
  })
  await store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'harvest.session.started',
    payload: {
      run,
      session: 'old-alternate',
      role: 'harvest',
      runner: 'scripted',
      args: ['alternate'],
      step: 'synthesize',
      round: 1,
    },
  })
  await store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'harvest.session.suspended',
    payload: {
      run,
      session: 'old-alternate',
      cause: 'shutdown',
      transcript: { kind: 'harvest-transcript', rev: 0 },
    },
  })
  const producerTurns: Array<{ args: readonly string[]; turn: number }> = []
  let reviews = 0
  const scripted = new ScriptedAgentRunner({
    script: async ({ opts, turn }) => {
      const env = resolveHarvestCliEnv(opts.env)
      const deps = { store, env, workspacePath: workspace, ids }
      await buildHarvestContext(deps)
      if (opts.skill === 'ab-harvest') {
        producerTurns.push({ args: opts.args ?? [], turn })
        const observations = JSON.parse(
          await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
        )
        const file = join(workspace, '.ab', `proposals-${producerTurns.length}.json`)
        await writeFile(
          file,
          JSON.stringify(proposalSet(observations, `Specific defect ${producerTurns.length}`)),
        )
        await submitHarvestProposals(deps, file)
      } else {
        reviews += 1
        const notes = join(workspace, '.ab', 'review.md')
        await writeFile(notes, reviews === 1 ? 'revise' : 'approve')
        if (reviews === 1) {
          const findings = join(workspace, '.ab', 'review-findings.json')
          await writeFile(
            findings,
            JSON.stringify([{ severity: 'important', summary: 'Make the title specific' }]),
          )
          await submitHarvestVerdict(deps, { verdict: 'revise', notes, findings })
        } else await submitHarvestVerdict(deps, { verdict: 'approve', notes })
      }
      return defaultTurnResult('done')
    },
  })
  const cfg = config(1)
  cfg.roles.default!.args = ['primary']
  cfg.roles.default!.alternates = [{ runtime: 'scripted', args: ['alternate'] }]
  const result = await new HarvestRunner({
    store,
    tickets,
    config: cfg,
    runtimes: { scripted: { runner: scripted, servesModels: [''] } },
    repo: '/repo',
    workspacePath: workspace,
    ids,
    uuids: randomUuids(),
    clock: steppingClock(),
    instance: 'next',
  }).run()
  expect(result.outcome).toBe('completed')
  expect(producerTurns).toEqual([
    { args: ['alternate'], turn: 1 },
    { args: ['primary'], turn: 1 },
  ])
  const events = await store.getRepoEvents('/repo')
  expect(
    events
      .filter((e) => e.type === 'harvest.session.started')
      .filter((e) => e.payload.role === 'harvest')
      .map((e) => e.payload.args),
  ).toEqual([['alternate'], ['alternate'], ['primary']])
  expect(events.filter((e) => e.type === 'harvest.proposal.filed')).toHaveLength(1)
})
