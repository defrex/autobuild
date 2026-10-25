import { expect, test } from 'bun:test'
import { integrationDiagram } from './integration-diagram'

test('the integration figure is the website node as ab ticket tree prints it', () => {
  const html = integrationDiagram()
  expect(html.match(/data-capture-figure="integration-tree"/g)).toHaveLength(1)
  expect(html).not.toContain('data-capture-animated')
  expect(html).toContain('role="region" aria-label="ab ticket tree output')
  const text = html.replace(/<[^>]+>/g, '')
  expect(text).toContain('$ bun ab ticket tree')
  expect(text).toContain('  AUT-837 [node] Website for 1.0')
  expect(text.match(/^ {4}AUT-\d+ \[work\] \(Done\) /gm)).toHaveLength(11)
  expect(text).toContain('11 tickets merged on ab-node/website-integration')
})
