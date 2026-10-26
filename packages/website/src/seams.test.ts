import { describe, expect, test } from 'bun:test'
import { SEAMS, initialState, selectAdapter, setAll, summary, toggleTrack } from './seams'

describe('seam model', () => {
  test('opens fully local with one adapter per seam', () => {
    const state = initialState()
    expect(Object.keys(state)).toHaveLength(SEAMS.length)
    expect(summary(state)).toEqual({ remoteCount: 0, total: 5, knob: 0, label: 'fully local' })
  })

  test('setAll remote is fully remote and selects Codex for runtime', () => {
    const state = setAll(initialState(), 'remote')
    expect(summary(state).label).toBe('fully remote')
    expect(state.runtime).toBe('codex')
    expect(summary(state).knob).toBe(1)
  })

  test('setAll local selects Claude Code and round-trips to the initial state', () => {
    const remote = setAll(initialState(), 'remote')
    expect(setAll(remote, 'local').runtime).toBe('claude-code')
    expect(setAll(remote, 'local')).toEqual(initialState())
  })

  test('the track swaps the runtime with the extremes', () => {
    const remote = toggleTrack(initialState())
    expect(remote.runtime).toBe('codex')
    expect(toggleTrack(remote).runtime).toBe('claude-code')
    expect(toggleTrack(selectAdapter(initialState(), 'forge', 'github')).runtime).toBe('codex')
  })

  test('single chips never change the runtime, even when they complete the remote set', () => {
    let state = initialState()
    for (const [seam, adapter] of [
      ['tickets', 'linear'],
      ['workspace', 'vercel-sandbox'],
      ['forge', 'github'],
      ['store', 'remote-store'],
      ['operators', 'operator-api'],
    ] as const)
      state = selectAdapter(state, seam, adapter)
    expect(summary(state).label).toBe('fully remote')
    expect(state.runtime).toBe('claude-code')
    expect(selectAdapter(state, 'runtime', 'pi').runtime).toBe('pi')
    expect(selectAdapter(state, 'runtime', 'codex').runtime).toBe('codex')
  })

  test('mixed selections report N of M, excluding one-sided seams', () => {
    let state = selectAdapter(initialState(), 'workspace', 'vercel-sandbox')
    expect(summary(state)).toMatchObject({ remoteCount: 1, total: 5, label: '1 of 5 seams remote' })
    state = selectAdapter(state, 'runtime', 'codex')
    expect(summary(state).total).toBe(5)
    expect(summary(state).knob).toBeCloseTo(1 / 5)
  })

  test('neutral adapters count as not remote', () => {
    const state = selectAdapter(setAll(initialState(), 'remote'), 'tickets', 'hosted')
    expect(summary(state).label).toBe('4 of 5 seams remote')
  })

  test('the track goes remote unless everything is remote already', () => {
    const local = initialState()
    expect(summary(toggleTrack(local)).label).toBe('fully remote')
    const mixed = selectAdapter(local, 'forge', 'github')
    expect(summary(toggleTrack(mixed)).label).toBe('fully remote')
    expect(summary(toggleTrack(setAll(local, 'remote'))).label).toBe('fully local')
  })

  test('every seam keeps exactly one valid selection, and unknown ids are ignored', () => {
    let state = initialState()
    for (const seam of SEAMS)
      for (const a of seam.adapters) state = selectAdapter(state, seam.id, a.id)
    state = selectAdapter(state, 'forge', '+ plugin')
    for (const seam of SEAMS)
      expect(seam.adapters.map((a) => a.id)).toContain(state[seam.id] as string)
  })
})

test('dispatcher remains local at both extremes and removed offerings cannot select', () => {
  for (const side of ['local', 'remote'] as const) {
    const state = setAll(initialState(), side)
    expect(state.dispatcher).toBe('local-process')
    expect(selectAdapter(state, 'dispatcher', 'cron')).toBe(state)
    expect(selectAdapter(state, 'operators', 'web-ui')).toBe(state)
    expect(selectAdapter(state, 'operators', 'mcp').operators).toBe('mcp')
  }
  expect(
    SEAMS.find((seam) => seam.id === 'operators')?.adapters.find((adapter) => adapter.id === 'mcp')
      ?.label,
  ).toBe('stdio MCP')
})
