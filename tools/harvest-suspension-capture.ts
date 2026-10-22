import { KERNEL } from '../packages/core/src/events/envelope'
import type { RepositoryEvent } from '../packages/core/src/events/repository'
import { projectHarvest } from '../packages/core/src/cli/dashboard/model'

/** Durable fixture shared by the terminal and browser captures. */
export function harvestSuspensionCapture() {
  const run = 'harvest-suspended-capture'
  const specs = [
    {
      type: 'harvest.started',
      payload: {
        run,
        observations: [{ build: 'capture', seq: 1 }],
        scan: { kind: 'harvest-scan', rev: 0 },
      },
    },
    { type: 'harvest.step.started', payload: { run, step: 'synthesize', round: 1 } },
    {
      type: 'harvest.session.started',
      payload: {
        run,
        session: 'hs_capture',
        role: 'harvest',
        runner: 'pi',
        step: 'synthesize',
        round: 1,
      },
    },
    {
      type: 'harvest.session.suspended',
      payload: {
        run,
        session: 'hs_capture',
        cause: 'cutover',
        transcript: { kind: 'harvest-transcript', rev: 0 },
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
