import { expect, test } from 'bun:test'
import { dispatcherDiagram, dispatcherLegend, intakeDiagram } from './diagrams'
import { dispatcherRenderer, stateAt as dispatcher } from './dispatcher-motion'
import { intakeRenderer, stateAt as intake } from './intake-motion'

test('claims precede starts and writes, with earlier runners remaining active', () => {
  for (let i = 0; i < 3; i++) {
    expect(dispatcher(i * 1600)?.active).toContain(`ticket-${i}`)
    expect(dispatcher(i * 1600 + 400)?.active).toContain(`start-${i}`)
    expect(dispatcher(i * 1600 + 800)?.active).toContain(`runner-${i}`)
    expect(dispatcher(i * 1600 + 1200)?.active).toContain(`write-${i}`)
    expect(dispatcher(i * 1600 + 1200)?.running).toHaveLength(i + 1)
  }
  expect(dispatcher(2400)?.running).toEqual(['runner-0', 'runner-1'])
})

test('all four sources pass through PM routing before delivery', () => {
  for (let i = 0; i < 4; i++) {
    expect(intake(i * 1200)?.active).toEqual([`source-${i}`])
    expect(intake(i * 1200 + 400)?.active).toEqual(['route', 'pm'])
    expect(intake(i * 1200 + 800)?.active).toEqual(['delivery', 'queue'])
  }
  expect(intake(2400)?.active).toEqual(['source-2'])
})

for (const [name, markup, timeline, renderer] of [
  ['dispatcher', dispatcherDiagram, dispatcher, dispatcherRenderer],
  ['intake', intakeDiagram, intake, intakeRenderer],
] as const) {
  test(`${name} maps both layouts and restores every primitive after arbitrary seeks`, () => {
    const html = markup()
    const legend = dispatcherLegend()
    const elements = [...html.matchAll(/data-sequence-key="([^"]+)"/g)].map((match) => ({
      dataset: { sequenceKey: match[1] },
      attrs: new Map<string, string>(),
      setAttribute(key: string, value: string) {
        this.attrs.set(key, value)
      },
      removeAttribute(key: string) {
        this.attrs.delete(key)
      },
    }))
    const root = { querySelectorAll: () => elements } as unknown as ParentNode
    const render = renderer(root)
    expect(timeline(-1)).toEqual(timeline(0))
    expect(timeline(4799)).not.toBeNull()
    expect(timeline(4800)).toBeNull()
    expect(timeline(5000)).toBeNull()
    for (const time of [0, 2400, 4400, 400, 0, 2400]) {
      render(time)
      for (const key of timeline(time)!.active) {
        // Shared paths have a desktop and phone counterpart; desktop-only indexed
        // runner paths have a common phone path instead.
        if (/^(start|write)-/.test(key) || key === 'start' || key === 'write') continue
        expect(
          elements.filter((el) => el.dataset.sequenceKey === key).length,
        ).toBeGreaterThanOrEqual(2)
      }
      const first = elements.map((el) => [...el.attrs])
      render(time)
      expect(elements.map((el) => [...el.attrs])).toEqual(first)
      expect(
        elements
          .filter((el) => ['human', 'escalation'].includes(el.dataset.sequenceKey!))
          .every((el) => el.attrs.size === 0),
      ).toBe(true)
    }
    render(4800)
    expect(elements.every((el) => el.attrs.size === 0)).toBe(true)
    expect(markup().replace(/arrow-\d+/g, 'arrow')).toBe(html.replace(/arrow-\d+/g, 'arrow'))
    expect(dispatcherLegend()).toBe(legend)
  })
}
