import { expect, test } from 'bun:test'
import { DURATION, pipelineRenderer, stateAt } from './pipeline-motion'
import { pipelineDiagram } from './diagrams'

test('twelve beats show both review returns and approvals before advancing', () => {
  expect(Array.from({ length: 12 }, (_, i) => stateAt(i * 400)?.node)).toEqual([
    'spec',
    'plan',
    'plan-review',
    'plan',
    'plan-review',
    'implement',
    'code-review',
    'implement',
    'code-review',
    'verify:*',
    'finalize',
    'merged',
  ])
  expect(stateAt(1200)?.edge).toBe('plan-return')
  expect(stateAt(2800)?.edge).toBe('code-return')
  expect(stateAt(1199)?.node).toBe('plan-review')
  expect(stateAt(1599)?.node).toBe('plan')
  expect(stateAt(2400)?.node).toBe('code-review')
  expect(stateAt(-1)?.node).toBe('spec')
  expect(stateAt(DURATION)).toBeNull()
  expect(stateAt(DURATION + 100)).toBeNull()
})

test('renderer changes only transient attributes on both responsive copies', () => {
  const html = pipelineDiagram()
  const elements = [...html.matchAll(/data-motion-(node|edge)="([^"]+)"/g)].map((match) => ({
    kind: match[1],
    dataset: {
      motionNode: match[1] === 'node' ? match[2] : undefined,
      motionEdge: match[1] === 'edge' ? match[2] : undefined,
    },
    attrs: new Map<string, string>(),
    toggleAttribute(key: string, value: boolean) {
      if (value) this.attrs.set(key, '')
      else this.attrs.delete(key)
    },
    setAttribute(key: string, value: string) {
      this.attrs.set(key, value)
    },
    removeAttribute(key: string) {
      this.attrs.delete(key)
    },
  }))
  const root = {
    querySelectorAll(selector: string) {
      return elements.filter((element) => selector.includes(element.kind!))
    },
  } as unknown as ParentNode
  const render = pipelineRenderer(root)
  for (const time of [0, 1200, 2400, 2800, 4400]) {
    render(time)
    expect(elements.filter((el) => el.attrs.has('data-motion-active'))).toHaveLength(2)
    expect(elements.filter((el) => el.attrs.get('data-motion-traversed') === 'true').length).toBe(
      time === 0 ? 0 : 2,
    )
  }
  render(DURATION)
  expect(elements.every((el) => el.attrs.size === 0)).toBe(true)
})
