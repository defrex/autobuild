/** Generated-file regeneration outcomes render as one-line watch summaries. */
import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import { summarizeEvent } from './watch'

const event = (type: 'restack.regenerated' | 'node.item-regenerated', payload: object) =>
  ({
    build: 'leaf',
    seq: 3,
    ts: '2026-11-20T00:00:00.000Z',
    actor: KERNEL,
    type,
    payload: {
      id: 'tx',
      ...(type === 'node.item-regenerated' ? { index: 0, base: 'b'.repeat(40) } : {}),
      files: ['gen.json'],
      commands: [{ command: 'bun gen', files: ['gen.json'] }],
      ...payload,
    },
  }) as AbEvent

test('each regeneration outcome says what happened', () => {
  expect(
    summarizeEvent(
      event('restack.regenerated', { outcome: 'resolved', head: 'a'.repeat(40) }),
      null,
    ),
  ).toBe('replay resolved by regeneration (`bun gen`): gen.json')
  expect(
    summarizeEvent(event('node.item-regenerated', { outcome: 'failed', reason: 'exit 2' }), null),
  ).toBe('regeneration failed: exit 2; an agent reconciles')
  expect(
    summarizeEvent(
      event('restack.regenerated', {
        outcome: 'skipped',
        reason: 'conflicts outside [[generated]]: src/a.ts',
      }),
      null,
    ),
  ).toBe('regeneration skipped (undeclared conflicts): conflicts outside [[generated]]: src/a.ts')
})
