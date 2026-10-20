import { expect, test } from 'bun:test'
import { integrationDiagram } from './integration-diagram'

test('complete static tree has both contributions, branch, sequence and one replay control', () => {
  const html = integrationDiagram()
  expect(html.match(/data-capture-figure="integration-tree"/g)).toHaveLength(1)
  expect(html.match(/data-capture-animated/g)).toHaveLength(1)
  expect(html.match(/data-motion-replay hidden/g)).toHaveLength(1)
  expect(html).toContain('aria-label="Replay integration tree animation"')
  const visible = html.replace(/<[^>]+>/g, ' ')
  for (const label of [
    '[x] main',
    'node · NODE-1',
    'ab-node/release',
    '[x] build A',
    '[x] build B',
    '1 build A lands',
    '2 build B restacks → lands',
    '3 node complete → verify:*',
    '4 consent → land into main',
  ]) {
    expect(visible.split(label).length - 1).toBe(2)
  }
  expect(html).toContain('B restacks onto the new node head and lands')
  expect(html).not.toContain('data-motion-node')
  expect(html).not.toContain('data-motion-edge')
  const descriptions = [...html.matchAll(/role="img" aria-label="([^"]+)"/g)].map((m) => m[1])
  expect(descriptions).toHaveLength(2)
  expect(descriptions[0]).toBe(descriptions[1])
})
