import { expect, test } from 'bun:test'
import { integrationDiagram } from './integration-diagram'
import { DURATION, integrationRenderer, stateAt } from './integration-motion'

test('landing and new-head restack precede completeness, verification and consent', () => {
  const beats = ['a-land', 'restack', 'b-land', 'complete', 'verify', 'consent']
  expect(DURATION).toBe(6000)
  for (const [i, beat] of beats.entries()) {
    expect(stateAt(i * 1000)).toBe(beat)
    expect(stateAt(i * 1000 + 999)).toBe(beat)
  }
  expect(stateAt(-1)).toBe('a-land')
  expect(stateAt(DURATION)).toBeNull()
  expect(stateAt(DURATION + 1)).toBeNull()
})

test('both drawings emphasize matching beats and clean up without touching pipeline attributes', () => {
  const elements = [...integrationDiagram().matchAll(/data-integration-beats="([^"]+)"/g)].map(
    (m) => ({
      dataset: { integrationBeats: m[1] },
      attrs: new Set<string>(),
      toggleAttribute(key: string, active: boolean) {
        expect(key).toBe('data-integration-active')
        if (active) this.attrs.add(key)
        else this.attrs.delete(key)
      },
    }),
  )
  const render = integrationRenderer({
    querySelectorAll(selector: string) {
      expect(selector).toBe('[data-integration-beats]')
      return elements
    },
  } as unknown as ParentNode)
  for (let time = 0; time < DURATION; time += 1000) {
    render(time)
    const active = elements.filter((el) => el.attrs.size)
    expect(active.length).toBeGreaterThanOrEqual(4)
    expect(active.length % 2).toBe(0)
    expect(
      active.every((el) => el.dataset.integrationBeats!.split(' ').includes(stateAt(time)!)),
    ).toBe(true)
  }
  render(DURATION)
  expect(elements.every((el) => el.attrs.size === 0)).toBe(true)
})
