import { expect, test } from 'bun:test'
import { evaluateBinModes } from './bin-mode-check'
test('evaluates tracked, untracked, conflicting and non-executable entries', () => {
  const target = 'src/bin.ts'
  const modes = new Map([[target, ['100755']]])
  expect(
    evaluateBinModes(
      [{ manifestPath: 'p', packageName: 'p', name: 'n', target }],
      modes,
      new Map([[target, true]]),
    ),
  ).toEqual([])
  expect(
    evaluateBinModes(
      [{ manifestPath: 'p', packageName: 'p', name: 'n', target }],
      new Map(),
      new Map(),
    ),
  ).toEqual([
    { kind: 'untracked', entry: { manifestPath: 'p', packageName: 'p', name: 'n', target } },
  ])
  expect(
    evaluateBinModes(
      [{ manifestPath: 'p', packageName: 'p', name: 'n', target }],
      new Map([[target, ['100644', '100755']]]),
      new Map(),
    ),
  ).toEqual([
    {
      kind: 'conflict',
      entry: { manifestPath: 'p', packageName: 'p', name: 'n', target },
      modes: ['100644', '100755'],
    },
  ])
  expect(
    evaluateBinModes(
      [{ manifestPath: 'p', packageName: 'p', name: 'n', target }],
      modes,
      new Map([[target, false]]),
    ),
  ).toEqual([
    {
      kind: 'worktree-mode',
      entry: { manifestPath: 'p', packageName: 'p', name: 'n', target },
      indexMode: '100755',
    },
  ])
})
