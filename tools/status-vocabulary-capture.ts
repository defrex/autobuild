import { KERNEL } from '../packages/core/src/events/envelope'
import type { RepositoryEvent } from '../packages/core/src/events/repository'
import { projectHarvest, type DashboardModel } from '../packages/core/src/cli/dashboard/model'
import type { DashboardBuild } from '../packages/core/src/cli/dashboard/model'
import { buildRowStatus } from '../packages/core/src/cli/dashboard/row-text'

/**
 * The model with three of its running rows re-projected into the status words
 * no scripted scenario reaches (SPEC §14 "Status words"): an abort winding a
 * runner down (`ABORTING`, still holding its slot), a finished pipeline with
 * merge consent waiting on the forge (`MERGING`), and one waiting for its merge
 * decision (`WAITING`). Each row's lifecycle facts, slot and the active count
 * change together, so a green word still means a held slot.
 */
export function statusVocabularyCapture(model: DashboardModel): DashboardModel {
  // Rows that hold their slot (an unknown slot on a running row is inferred
  // held, as every surface infers it).
  const running = model.builds.filter(
    (build) =>
      build.integrationRow === undefined &&
      (build.slot?.state === 'held' || (build.slot === undefined && build.status === 'running')),
  )
  // The row with a PR is the natural one to wait on the forge.
  const merging = running.find((build) => build.pr !== undefined) ?? running[0]
  const [aborting, deciding] = running.filter((build) => build !== merging)
  if (merging === undefined || deciding === undefined)
    throw new Error('status vocabulary capture needs three running work rows')
  // A finished pipeline: every step done, the merge step waiting.
  const settled = (build: DashboardBuild, kind: 'merging' | 'decision'): DashboardBuild => ({
    ...build,
    slot: { state: 'none' },
    statusBasis: { resting: 'running', runner: false, settled: kind },
    steps: build.steps.map(({ timing, ...step }) =>
      step.label === 'merge'
        ? { ...step, state: 'current' as const }
        : {
            ...step,
            state: 'done' as const,
            ...(timing !== undefined ? { timing: { accumulatedMs: timing.accumulatedMs } } : {}),
          },
    ),
  })
  const builds = model.builds.map((build) =>
    build.slug === aborting!.slug
      ? {
          ...build,
          status: 'aborting' as const,
          statusBasis: {
            ...(build.statusBasis ?? { resting: 'running' as const, runner: true }),
            abort: true as const,
          },
          steps: [],
          abortProgress: 'abort requested; waiting for running work to stop',
        }
      : build.slug === merging.slug
        ? settled(build, 'merging')
        : build.slug === deciding.slug
          ? settled(build, 'decision')
          : build,
  )
  const held = builds.filter((build) => buildRowStatus(build).tone === 'ok').length
  return {
    ...model,
    builds,
    active: { ...model.active, current: held },
    ...(model.capacity
      ? {
          capacity: {
            ...model.capacity,
            occupied: held,
            slots: Object.fromEntries(
              builds.flatMap((build) => (build.slot ? [[build.slug, build.slot]] : [])),
            ),
          },
        }
      : {}),
  }
}

/** A harvest run that needs a human: escalated by its agent, or failed on
 * infrastructure. Durable fixtures shared by the terminal and browser captures. */
export function harvestAttentionCapture(outcome: 'escalated' | 'failed') {
  const run = `harvest-${outcome}-capture`
  const observations = [{ build: 'capture', seq: 1 }]
  const specs = [
    {
      type: 'harvest.started',
      payload: { run, observations, scan: { kind: 'harvest-scan', rev: 0 } },
    },
    { type: 'harvest.step.started', payload: { run, step: 'synthesize', round: 1 } },
    outcome === 'escalated'
      ? {
          type: 'harvest.escalated',
          payload: {
            run,
            source: 'agent',
            reason: 'Two observations disagree on the retry policy.',
            round: 1,
            observations,
          },
        }
      : {
          type: 'harvest.failed',
          payload: {
            run,
            step: 'synthesize',
            round: 1,
            attempt: 1,
            error: 'runner unavailable',
            willRetry: false,
          },
        },
  ]
  const events = specs.map((spec, index) => ({
    ...spec,
    actor: KERNEL,
    repo: '/capture',
    seq: index + 1,
    ts: new Date(Date.UTC(2026, 6, 15, 12, 0, index)).toISOString(),
  })) as RepositoryEvent[]
  return projectHarvest(events)!
}
