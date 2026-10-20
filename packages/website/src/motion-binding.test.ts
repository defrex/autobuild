import { expect, test } from 'bun:test'
import { bindFigureMotion } from './motion-binding'

test('figures register independently and missing browser APIs leave the static fallback', () => {
  const oldWindow = globalThis.window
  const oldDocument = globalThis.document
  const calls: Record<string, number[]> = { dispatcher: [], intake: [] }
  const control = { hidden: true }
  try {
    Object.assign(globalThis, {
      window: {},
      document: { querySelector: () => ({ querySelector: () => control }) },
    })
    for (const id of ['dispatcher', 'intake']) {
      bindFigureMotion(id, 4800, () => (time) => calls[id]!.push(time))
    }
    window.__websiteCapture!.dispatcher!.seek(0, { still: false })
    expect(calls.dispatcher).toEqual([4800])
    expect(calls.intake).toEqual([])
    expect(control.hidden).toBe(true)
    window.__websiteCapture!.intake!.seek(2400, { still: false })
    expect(calls.intake).toEqual([4800])
    expect(Object.keys(window.__websiteCapture!)).toEqual(['dispatcher', 'intake'])
  } finally {
    Object.assign(globalThis, { window: oldWindow, document: oldDocument })
  }
})

test('initialization failure restores the static drawing and hides Replay', () => {
  const oldWindow = globalThis.window
  const oldDocument = globalThis.document
  const times: number[] = []
  const control = { hidden: true }
  try {
    Object.assign(globalThis, {
      window: {
        IntersectionObserver: () => {},
        requestAnimationFrame: () => {},
        matchMedia: () => {
          throw new Error('unavailable')
        },
      },
      document: { querySelector: () => ({ querySelector: () => control }) },
    })
    bindFigureMotion('dispatcher', 4800, () => (time) => times.push(time))
    expect(times).toEqual([4800])
    expect(control.hidden).toBe(true)
    expect(window.__websiteCapture!.dispatcher!.duration).toBe(4800)
  } finally {
    Object.assign(globalThis, { window: oldWindow, document: oldDocument })
  }
})
