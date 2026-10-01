import { describe, expect, test } from 'bun:test'
import { SEAMS, initialState, selectAdapter, setAll, summary, toggleTrack } from './seams'

describe('seam model', () => {
  test('opens fully local with one adapter per seam', () => {
    const state = initialState()
    expect(Object.keys(state)).toHaveLength(SEAMS.length)
    expect(summary(state)).toEqual({ remoteCount: 0, total: 6, knob: 0, label: 'fully local' })
  })

  test('setAll remote is fully remote and leaves runtime alone', () => {
    const state = setAll(initialState(), 'remote')
    expect(summary(state).label).toBe('fully remote')
    expect(state.runtime).toBe(initialState().runtime)
    expect(summary(state).knob).toBe(1)
  })

  test('mixed selections report N of M, excluding runtime', () => {
    let state = selectAdapter(initialState(), 'dispatcher', 'cron')
    expect(summary(state)).toMatchObject({ remoteCount: 1, total: 6, label: '1 of 6 seams remote' })
    state = selectAdapter(state, 'runtime', 'codex')
    expect(summary(state).total).toBe(6)
    expect(summary(state).knob).toBeCloseTo(1 / 6)
  })

  test('neutral adapters count as not remote', () => {
    const state = selectAdapter(setAll(initialState(), 'remote'), 'tickets', 'hosted')
    expect(summary(state).label).toBe('5 of 6 seams remote')
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
