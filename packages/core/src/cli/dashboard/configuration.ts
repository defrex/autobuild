import type { DashboardModel } from './model'

/** The one factual line every frontend shows where pipeline configuration
 * would appear while no dispatcher has run for the repository. */
export const NO_DISPATCHER_RUN_LINE = 'No dispatcher has run for this project yet.'

/** The Active counter: `–` while no dispatcher run supplies a capacity. */
export function activeCounterText(model: Pick<DashboardModel, 'active' | 'configuration'>): string {
  if (model.configuration === 'no-dispatcher-run') return '–'
  return `${model.active.current}/${model.active.limit}`
}
