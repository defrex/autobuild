/** Seeded generated repository journals for the incremental reducer property tests. */
import { DISPATCHER, KERNEL, humanActor } from '../../events/envelope'
import type { RepositoryEvent } from '../../events/repository'
import { pick, seededRandom } from '../incremental-contract'

type Spec = { type: string; payload: Record<string, unknown>; actor?: RepositoryEvent['actor'] }

function toJournal(specs: Spec[], shuffleTs = false): RepositoryEvent[] {
  return specs.map(
    (spec, index) =>
      ({
        repo: 'acme/repo',
        seq: index + 1,
        ts: new Date(
          Date.UTC(2026, 0, 1, 0, 0, shuffleTs ? (index * 7) % 13 : index),
        ).toISOString(),
        actor: spec.actor ?? KERNEL,
        type: spec.type,
        payload: spec.payload,
      }) as RepositoryEvent,
  )
}

/** Valid harvest lifecycles only (the reducer throws on dangling references):
 * runs start one at a time with fresh observations; pause/resume facts and
 * failures interleave while a run is open. */
export function randomHarvestJournal(seed: number, length: number): RepositoryEvent[] {
  const rand = seededRandom(seed)
  const specs: Spec[] = []
  let runNo = 0
  let open: { run: string; obs: Array<{ build: string; seq: number }> } | undefined
  let parked = false
  for (let i = 0; i < length; i++) {
    const r = rand()
    if (open === undefined) {
      runNo += 1
      const obs = [{ build: `b${runNo}`, seq: 1 }]
      open = { run: `h_${runNo}`, obs }
      parked = false
      specs.push({
        type: 'harvest.started',
        payload: { run: open.run, observations: obs, scan: { kind: 'harvest-scan', rev: runNo } },
      })
      continue
    }
    if (r < 0.15) {
      specs.push({ type: 'harvest.pause-requested', payload: {}, actor: humanActor('aron') })
    } else if (r < 0.25) {
      specs.push({ type: 'harvest.resume-requested', payload: {}, actor: humanActor('aron') })
    } else if (r < 0.35) {
      specs.push({ type: 'harvest.paused', payload: {} })
    } else if (r < 0.5) {
      specs.push({ type: 'harvest.resumed', payload: {} })
      parked = false
    } else if (r < 0.7 && !parked) {
      const willRetry = rand() < 0.5
      specs.push({
        type: 'harvest.failed',
        payload: { run: open.run, step: 'file', attempt: 1, error: 'boom', willRetry },
      })
      if (!willRetry) parked = true
    } else if (r < 0.8 && !parked) {
      specs.push({
        type: 'harvest.completed',
        payload: {
          run: open.run,
          dispositions: [
            { occurrence: open.obs[0], action: 'suppressed', proposalKey: `k${runNo}` },
          ],
          report: { kind: 'harvest-report', rev: runNo },
        },
      })
      open = undefined
    } else if (r < 0.9 && !parked) {
      specs.push({
        type: 'harvest.escalated',
        payload: { run: open.run, source: 'agent', reason: 'judgment', observations: open.obs },
      })
      open = undefined
    } else {
      specs.push({
        type: 'dispatcher.intake-set',
        payload: { enabled: rand() < 0.5 },
        actor: DISPATCHER,
      })
    }
  }
  return toJournal(specs)
}

export function randomSettingsJournal(seed: number, length: number): RepositoryEvent[] {
  const rand = seededRandom(seed)
  const specs: Spec[] = Array.from({ length }, () => ({
    type: pick(rand, [
      'dispatcher.intake-set',
      'dispatcher.pause-set',
      'dispatcher.auto-merge-default-set',
      'harvest.paused',
    ]),
    payload: { enabled: rand() < 0.5 },
    actor: humanActor('aron'),
  }))
  return toJournal(specs)
}

const counters = {
  claimed: 0,
  launched: 0,
  merged: 0,
  closed: 0,
  conflicted: 0,
  reconciled: 0,
  harvestStarted: 0,
  harvestCompleted: 0,
  harvestEscalated: 0,
  harvestFailed: 0,
}

export function randomStatusJournal(seed: number, length: number): RepositoryEvent[] {
  const rand = seededRandom(seed)
  const specs: Spec[] = []
  for (let i = 0; i < length; i++) {
    const run = pick(rand, ['run-a', 'run-b'])
    const templates: Array<() => Spec> = [
      () => ({
        type: 'dispatcher.run-started',
        payload: {
          run,
          pid: 100,
          effectiveConfig: { kind: 'dispatcher-effective-config', rev: i },
          roleWarnings: ['w'],
        },
      }),
      () => ({
        type: 'dispatcher.tick-completed',
        payload: {
          run,
          queued: i,
          counters: { ...counters, creationWithheld: 1 },
          janitorDiagnostics: ['j'],
          ticketDiagnostics: [],
          dependencyDiagnostics: [],
        },
      }),
      () => ({ type: 'dispatcher.tick-failed', payload: { run, error: 'e' } }),
      () => ({ type: 'dispatcher.config-rejected', payload: { run, error: 'bad' } }),
      () => ({
        type: 'dispatcher.operator-reported',
        payload: { run, level: pick(rand, ['info', 'warning']), message: 'm' },
      }),
      () => ({ type: 'dispatcher.upgrade-available', payload: { run, version: '1.0.0' } }),
      () => ({
        type: 'dispatcher.run-stopped',
        payload: { run, outcome: pick(rand, ['normal', 'abnormal']) },
      }),
    ]
    specs.push({ ...pick(rand, templates)(), actor: DISPATCHER })
  }
  return toJournal(specs)
}

export function randomSandboxJournal(seed: number, length: number): RepositoryEvent[] {
  const rand = seededRandom(seed)
  const specs: Spec[] = []
  for (let i = 0; i < length; i++) {
    const base = { operator: 'op', environmentId: pick(rand, ['env_1', 'env_2']) }
    const templates: Array<() => Spec> = [
      () => ({
        type: 'orchestrator.sandbox.provisioned',
        payload: {
          ...base,
          provider: 'vercel',
          workspacePath: '/w',
          ...(rand() < 0.5 ? { sessionId: 's' } : {}),
        },
      }),
      () => ({ type: 'orchestrator.sandbox.resumed', payload: { ...base, provider: 'vercel' } }),
      () => ({ type: 'orchestrator.sandbox.activity', payload: base }),
      () => ({ type: 'orchestrator.sandbox.stopped', payload: { ...base, reason: 'idle' } }),
      () => ({ type: 'orchestrator.sandbox.reset', payload: base }),
      () => ({
        type: 'orchestrator.sandbox.released',
        payload: { ...base, snapshots: { outcome: 'confirmed' } },
      }),
    ]
    specs.push({ ...pick(rand, templates)(), actor: DISPATCHER })
  }
  // Non-monotonic timestamps exercise the `lastEvidenceTs <= ts` guards.
  return toJournal(specs, true)
}
