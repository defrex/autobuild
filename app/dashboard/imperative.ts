import type { DashboardModel } from 'autobuild/operator-presentation'

export type ImperativeWord = 'BLOCKED' | 'FAILED' | 'PR READY' | 'MERGED'
export type ImperativeTone = 'alert' | 'ready'

export interface Imperative {
  word: ImperativeWord
  tone: ImperativeTone
  /** How many rows carry this word; the header shows one word and this count. */
  count: number
}

/**
 * One imperative per frame. The header carries a single word chosen by
 * priority, never a list: a build parked on a human outranks a failure,
 * which outranks a pull request waiting to be reviewed or already landed.
 * Every input is a durable fact on the projected model; nothing here is
 * inferred from agent output.
 */
export function dashboardImperative(model: DashboardModel): Imperative | undefined {
  const blocked =
    model.builds.filter((build) => build.status === 'blocked' || build.blockers.length > 0).length +
    (model.harvest?.status === 'escalated' ? 1 : 0)
  if (blocked > 0) return { word: 'BLOCKED', tone: 'alert', count: blocked }

  const failed =
    model.builds.filter(
      (build) => build.setupError !== undefined || build.pr?.state === 'conflicted',
    ).length + (model.harvest?.status === 'failed' ? 1 : 0)
  if (failed > 0) return { word: 'FAILED', tone: 'alert', count: failed }

  const ready = model.builds.filter((build) => build.pr?.state === 'open').length
  if (ready > 0) return { word: 'PR READY', tone: 'ready', count: ready }

  const merged = model.builds.filter((build) => build.pr?.state === 'merged').length
  if (merged > 0) return { word: 'MERGED', tone: 'ready', count: merged }

  return undefined
}
