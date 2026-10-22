import { expect, test } from 'bun:test'
import { handPushedText, projectHandPushed } from './hand-pushed'

test('hand-pushed vocabulary distinguishes unavailable and empty inventory', () => {
  expect(handPushedText(projectHandPushed(undefined))).toBe('unknown')
  expect(handPushedText(projectHandPushed({ items: [] }))).toBe('unknown')
  expect(
    handPushedText(
      projectHandPushed({ items: [], inventory: { head: 'head', builds: [], foreign: [] } }),
    ),
  ).toBe('none')
})

test('confirmed alias chains retain original identity and reject cycles', () => {
  const node = {
    items: [],
    inventory: { head: 'head', builds: [], foreign: ['rewritten'] },
    foreignAliases: { rewritten: 'middle', middle: 'original' },
  }
  expect(handPushedText(projectHandPushed(node))).toBe('rewritten (original original)')
  node.foreignAliases.middle = 'rewritten'
  expect(() => projectHandPushed(node)).toThrow('cyclic foreign identity evidence')
})
