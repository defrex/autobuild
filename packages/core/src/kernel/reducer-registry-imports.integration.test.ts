/**
 * Import boundary for the reducer registry. The registry builds `REDUCERS`
 * at module load, so a static import cycle back to it lets whichever module
 * loads first decide whether startup works: loading the build runner first
 * once left `publishedBranchHeadReducer` in its temporal dead zone. Reducers
 * the registry needs live in `kernel/`; process modules re-export them.
 */
import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { REDUCERS } from './reducer-registry'
import { rel, valueEdges } from '../testing/import-graph'

/** processes/ modules the reducer registry still imports reducers from.
 * Each is a pure reducer leaf that closes no cycle. This list only
 * shrinks: define new reducers in kernel/, and remove an entry when its
 * reducer moves there. Never add build-runner. */
const GRANDFATHERED_PROCESSES_IMPORTS = [
  'processes/build-execution-state.ts',
  'processes/dispatch-failure-budget.ts',
  'processes/dispatcher-selectors.ts',
  'processes/execution-no-progress.ts',
  'processes/execution-settlement.ts',
  'processes/harvest-execution-state.ts',
  'processes/infrastructure-failure-budget.ts',
  'processes/publication-state.ts',
  'processes/sandbox-state.ts',
  'processes/tick-state.ts',
] as const

const SRC = resolve(import.meta.dir, '..')
const REPO_ROOT = resolve(SRC, '../../..')
const REGISTRY = join(import.meta.dir, 'reducer-registry.ts')
const BUILD_RUNNER = join(SRC, 'processes/build-runner.ts')

describe('reducer registry import boundary', () => {
  test('the reducer registry imports values from no processes/ module outside the shrink-only allowlist', () => {
    expect(GRANDFATHERED_PROCESSES_IMPORTS).not.toContain('processes/build-runner.ts')
    const actual = valueEdges(REGISTRY)
      .map(rel)
      .filter((path) => path.startsWith('processes/'))
      .sort()
    const allowed: readonly string[] = GRANDFATHERED_PROCESSES_IMPORTS
    const unexpected = actual
      .filter((path) => !allowed.includes(path))
      .map(
        (path) =>
          `the reducer registry must not import values from ${path}; define the reducer in ` +
          'kernel/ and re-export it from the process module, as kernel/verify-diff-base.ts does',
      )
    const stale = allowed
      .filter((path) => !actual.includes(path))
      .map(
        (path) => `${path} is no longer imported; remove it from GRANDFATHERED_PROCESSES_IMPORTS`,
      )
    expect([...unexpected, ...stale]).toEqual([])
  })

  test('the reducer registry is in no static import cycle', () => {
    const predecessor = new Map<string, string>([[REGISTRY, '']])
    const queue = [REGISTRY]
    const reentries: string[] = []
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const next of valueEdges(current)) {
        if (next === REGISTRY) {
          const chain: string[] = []
          for (let at = current; at !== ''; at = predecessor.get(at) ?? '') chain.unshift(rel(at))
          reentries.push([...chain, rel(REGISTRY)].join(' → '))
        }
        if (predecessor.has(next)) continue
        predecessor.set(next, current)
        queue.push(next)
      }
    }
    expect(reentries, 'a module the reducer registry loads imports the registry back').toEqual([])
    expect(
      predecessor.has(BUILD_RUNNER),
      'the reducer registry must not load the build runner; move the reducer into kernel/',
    ).toBe(false)
  })

  test('build-runner and the registry load in either order in a fresh process', async () => {
    const value = REDUCERS.publishedBranchHeadValue!.reducer
    const expected = {
      identity: value.identity,
      version: value.version,
      empty: value.finish(value.initial()),
      headVersion: REDUCERS.publishedBranchHead!.reducer.version,
    }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('AB_')) env[key] = value
    }
    for (const order of [
      [BUILD_RUNNER, REGISTRY],
      [REGISTRY, BUILD_RUNNER],
    ]) {
      const script = `
        const loaded = []
        for (const path of ${JSON.stringify(order)}) loaded.push(await import(path))
        const { REDUCERS } = loaded[${order.indexOf(REGISTRY)}]
        const reducer = REDUCERS.publishedBranchHeadValue.reducer
        console.log(JSON.stringify({
          identity: reducer.identity,
          version: reducer.version,
          empty: reducer.finish(reducer.initial()),
          headVersion: REDUCERS.publishedBranchHead.reducer.version,
        }))
      `
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: REPO_ROOT,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const label = order.map(rel).join(' then ')
      expect(stderr, label).not.toContain('ReferenceError')
      expect(code, `${label}: ${stderr}`).toBe(0)
      expect(JSON.parse(stdout.trim()), label).toEqual(expected)
    }
  })
})
