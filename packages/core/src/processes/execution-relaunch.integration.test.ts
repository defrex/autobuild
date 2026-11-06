import { expect, test } from 'bun:test'
import { RUNTIME_IDENTITY } from '../runtime-identity'
import { reduceBuild } from '../kernel/reducer'
import type { AbEvent } from '../events/catalog'
import { relaunchTarget, sameRuntime } from './execution-relaunch'

test('full immutable identity comparison needs no Store access', () => {
  const runtime = RUNTIME_IDENTITY
  const state = reduceBuild([])
  expect(relaunchTarget(state, 'runner', runtime)).toBeUndefined()
  for (const to of [
    { ...runtime, commit: 'changed' },
    { ...runtime, source: { ...runtime.source, location: '/changed' } },
    {
      ...runtime,
      source: {
        ...runtime.source,
        kind: runtime.source.kind === 'source' ? ('package' as const) : ('source' as const),
      },
    },
  ]) {
    expect(sameRuntime(runtime, to)).toBe(false)
    const authorization = {
      instance: 'runner',
      correlation: 'handoff',
      run: 'old',
      runtime,
      targetRuntime: to,
    }
    state.drainingExecutions = { runner: { correlation: 'handoff', authorization } }
    expect(relaunchTarget(state, 'runner', runtime)?.to).toEqual(to)
    expect(relaunchTarget(state, 'foreign', runtime)).toBeUndefined()
  }
})

test('legacy, settled and ended authorizations preserve replay behavior', () => {
  const runtime = RUNTIME_IDENTITY
  const authorization = {
    type: 'execution.drain-authorized',
    payload: { instance: 'runner', correlation: 'h', run: 'old', runtime },
  } as AbEvent
  expect(relaunchTarget(reduceBuild([authorization]), 'runner', runtime)).toBeUndefined()
  const targeted = {
    ...authorization,
    payload: { ...authorization.payload, targetRuntime: { ...runtime, commit: 'f'.repeat(40) } },
  } as AbEvent
  for (const terminal of [
    { type: 'execution.drain-settled', payload: { instance: 'runner', correlation: 'h' } },
    {
      type: 'execution.ended',
      payload: { instance: 'runner', workspaceRef: 'w', outcome: 'relaunch' },
    },
  ] as AbEvent[]) {
    expect(relaunchTarget(reduceBuild([targeted, terminal]), 'runner', runtime)).toBeUndefined()
  }
})

test('replayed older authorizations cannot replace the newest target or resurrect settlement', () => {
  const runtime = RUNTIME_IDENTITY
  const authorization = (correlation: string, commit: string) =>
    ({
      type: 'execution.drain-authorized',
      payload: {
        instance: 'runner',
        correlation,
        run: 'old',
        runtime,
        targetRuntime: { ...runtime, commit },
      },
    }) as AbEvent
  const old = authorization('first', 'a'.repeat(40))
  const latest = authorization('second', 'b'.repeat(40))
  const state = reduceBuild([old, latest, old])
  expect(relaunchTarget(state, 'runner', runtime)?.correlation).toBe('second')
  expect(relaunchTarget(state, 'runner', runtime)?.to.commit).toBe('b'.repeat(40))
  const settled = {
    type: 'execution.drain-settled',
    payload: { instance: 'runner', correlation: 'second' },
  } as AbEvent
  expect(
    relaunchTarget(reduceBuild([old, latest, settled, latest]), 'runner', runtime),
  ).toBeUndefined()
})
