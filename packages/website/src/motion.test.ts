import { expect, test } from 'bun:test'
import { createMotion, type MotionEnvironment } from './motion'

function harness(reduced = false, hidden = false) {
  let enter = () => {}
  let preference = () => {}
  let visibility = () => {}
  let click = () => {}
  let disconnected = 0
  let serial = 0
  const frames = new Map<number, (time: number) => void>()
  const rendered: number[] = []
  const control = {
    hidden: true,
    addEventListener(_type: 'click', callback: () => void) {
      click = callback
    },
    removeEventListener() {
      click = () => {}
    },
  }
  const env: MotionEnvironment = {
    requestFrame(callback) {
      frames.set(++serial, callback)
      return serial
    },
    cancelFrame(id) {
      frames.delete(id)
    },
    observe(callback) {
      enter = callback
      return () => {
        disconnected++
      }
    },
    reduced: () => reduced,
    hidden: () => hidden,
    onReducedChange(callback) {
      preference = callback
      return () => {
        preference = () => {}
      }
    },
    onVisibilityChange(callback) {
      visibility = callback
      return () => {
        visibility = () => {}
      }
    },
  }
  const motion = createMotion(4800, (time) => rendered.push(time), control, env)
  return {
    motion,
    control,
    frames,
    rendered,
    enter: () => enter(),
    click: () => click(),
    reduced(value: boolean) {
      reduced = value
      preference()
    },
    hidden(value: boolean) {
      hidden = value
      visibility()
    },
    disconnected: () => disconnected,
    tick(time: number) {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(time)
    },
  }
}

test('offscreen is static; first intersection runs once and ends without scheduled work', () => {
  const h = harness()
  expect(h.rendered).toEqual([])
  h.enter()
  expect(h.disconnected()).toBe(1)
  h.tick(100)
  h.tick(2500)
  expect(h.rendered.at(-1)).toBe(2400)
  h.enter()
  expect(h.frames.size).toBe(1)
  h.tick(4900)
  expect(h.rendered.at(-1)).toBe(4800)
  expect(h.frames.size).toBe(0)
  h.enter()
  expect(h.frames.size).toBe(0)
})

test('replays cancel the prior clock, including rapid clicks', () => {
  const h = harness()
  h.enter()
  h.tick(0)
  h.tick(2000)
  h.click()
  h.click()
  h.click()
  expect(h.frames.size).toBe(1)
  expect(h.rendered.at(-1)).toBe(0)
  h.tick(5000)
  h.tick(5400)
  expect(h.rendered.at(-1)).toBe(400)
})

test('reduced motion initially and mid-run settles, and turning it off never autoplays', () => {
  for (const initial of [true, false]) {
    const h = harness(initial)
    h.enter()
    h.reduced(true)
    expect(h.control.hidden).toBe(true)
    expect(h.frames.size).toBe(0)
    expect(h.rendered.at(-1)).toBe(4800)
    h.reduced(false)
    h.enter()
    expect(h.control.hidden).toBe(false)
    expect(h.frames.size).toBe(0)
    h.click()
    expect(h.frames.size).toBe(1)
  }
})

test('hidden document settles and resuming does not repeat autoplay', () => {
  const h = harness()
  h.enter()
  h.tick(100)
  h.hidden(true)
  expect(h.rendered.at(-1)).toBe(4800)
  expect(h.frames.size).toBe(0)
  h.hidden(false)
  h.enter()
  expect(h.frames.size).toBe(0)
})

test('capture owns rendering permanently and acknowledges exact seeks', () => {
  const h = harness()
  h.enter()
  expect(h.motion.seek(2400, { still: false })).toEqual({
    timeMs: 2400,
    still: false,
    complete: false,
  })
  expect(h.rendered.at(-1)).toBe(2400)
  h.enter()
  h.click()
  expect(h.frames.size).toBe(0)
  h.motion.seek(0, { still: true })
  expect(h.rendered.at(-1)).toBe(4800)
  expect(h.control.hidden).toBe(true)
  expect(h.motion.seek(4800, { still: false }).complete).toBe(true)
  h.motion.dispose()
  expect(h.control.hidden).toBe(true)
})
