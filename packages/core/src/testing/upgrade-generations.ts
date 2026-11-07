/**
 * Pure dispatch-upgrade journal fixtures shared by the reducer, status and
 * read-budget tests. Run ids are padded to a fixed width so serialized sizes
 * do not differ between generation counts.
 */
import { DISPATCHER } from '../events/envelope'
import { validateRepositoryEventWrite, type RepositoryEventWrite } from '../events/repository'

export const upgradeRuntime = (version: string) => ({
  version,
  commit: 'unknown',
  source: { kind: 'package' as const, location: `/runtime/${version}` },
})

export const upgradeGenerationRun = (index: number) => `gen-${String(index).padStart(6, '0')}`

const write = (type: string, payload: unknown) =>
  validateRepositoryEventWrite({ actor: DISPATCHER, type, payload })

export function upgradeTarget(key: string) {
  return { mode: 'source' as const, key, source: '/origin', base: 'main', sha: key }
}

/** A dispatcher start that becomes authoritative and resolves a target. */
export function resolutionOnlyWrites(
  run: string,
  key: string,
  lineage = 'launcher',
): RepositoryEventWrite[] {
  return [
    write('dispatcher.run-started', {
      run,
      lineage,
      pid: 1,
      effectiveConfig: { kind: 'config', rev: 0 },
      roleWarnings: [],
    }),
    write('dispatcher.tick-started', { run }),
    write('dispatcher.upgrade-target-resolved', { run, lineage, target: upgradeTarget(key) }),
  ]
}

/** One complete generation: start, resolve, prepare, yield, hand off to the
 * next generation, release, take over and complete with nothing to drain. */
export function upgradeGenerationWrites(
  index: number,
  lineage = 'launcher',
): RepositoryEventWrite[] {
  const run = upgradeGenerationRun(index)
  const successor = upgradeGenerationRun(index + 1)
  const key = `k${String(index + 1).padStart(6, '0')}`
  const handoff = {
    correlation: `c-${run}`,
    run,
    lineage,
    from: upgradeRuntime(`1.${String(index).padStart(6, '0')}.0`),
    to: upgradeRuntime(`1.${String(index + 1).padStart(6, '0')}.0`),
    root: `/cache/${key}`,
    cacheId: key,
    target: upgradeTarget(key),
  }
  return [
    ...resolutionOnlyWrites(run, key, lineage),
    write('dispatcher.target-prepared', handoff),
    write('dispatcher.yield-requested', {
      ...handoff,
      successor,
      mode: 'drain',
      evidence: 'same schema',
    }),
    write('dispatcher.handoff-started', { ...handoff, successor, mode: 'drain', builds: [] }),
    write('dispatcher.terminal-released', handoff),
    write('dispatcher.takeover', { ...handoff, successor }),
    write('dispatcher.handoff-completed', { ...handoff, successor, mode: 'drain' }),
  ]
}
