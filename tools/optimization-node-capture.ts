import type { Config } from '../packages/core/src/config/schema'
import type { AbEvent } from '../packages/core/src/events/catalog'
import { DISPATCHER } from '../packages/core/src/events/envelope'
import {
  commandObjective,
  OPTIMIZATION_SHA,
  OptimizationLogBuilder,
} from '../packages/core/src/kernel/generators/optimization-log'
import { reduceBuild } from '../packages/core/src/kernel/reducer'
import { projectBuild, type DashboardModel } from '../packages/core/src/cli/dashboard/model'

export const OPTIMIZATION_NODE_SLUG = 'optimize-search-latency'
const TICKET = { source: 'fake', id: 'OPT-1', title: 'Cut catalog search p95 latency' }

/** A running optimization node's validated log: a measured baseline, one
 * accepted and one rejected attempt, two still in flight. It opens six hours
 * before the capture's render clock so the budget's hours are fixed. */
export function optimizationNodeEvents(repo: string): AbEvent[] {
  return new OptimizationLogBuilder(OPTIMIZATION_NODE_SLUG, Date.parse('2026-07-15T06:10:00.000Z'))
    .push({
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo,
        ticket: TICKET,
        baseBranch: 'main',
        kind: 'node',
      },
    })
    .accept(commandObjective({ target: { threshold: 35, epsilon: { relative: 0.03 } } }), 1)
    .wait(1)
    .push({ actor: DISPATCHER, type: 'node.opened', payload: { sha: OPTIMIZATION_SHA('a') } })
    .wait(10)
    .baseline(1, 50, 1.6)
    .wait(1)
    .propose('r1', ['a1', 'a2', 'a3', 'a4'])
    .wait(90)
    .settle('a1', 'accepted', { revision: 1, baseline: 50, candidate: 44, delta: 6 })
    .wait(45)
    .settle(
      'a2',
      'no-improvement',
      { revision: 1, baseline: 44, candidate: 43.5, delta: 0.5 },
      'within noise',
    ).events
}

/** The model with a running optimization node first in the list, projected
 * through the real reducer and shared projection. A renderer-level overlay
 * because a `--once` dispatch pass would act on a live optimization node:
 * request proposals, measure, and gate its stop and landing. */
export function optimizationNodeCapture(model: DashboardModel, config: Config): DashboardModel {
  const events = optimizationNodeEvents(model.repo)
  const record = {
    slug: OPTIMIZATION_NODE_SLUG,
    repo: model.repo,
    ticket: TICKET,
    createdAt: events[0]!.ts,
    updatedAt: events.at(-1)!.ts,
  }
  const node = projectBuild(record, reduceBuild(events), config, events)
  if (node?.objectiveRow === undefined) {
    throw new Error(`dashboard capture: ${OPTIMIZATION_NODE_SLUG} projected no objective row`)
  }
  return { ...model, builds: [node, ...model.builds] }
}
