import { expect, test } from 'bun:test'
import type { WorkspacePreservationHead } from '../ports/types'
import { supersedeRestorationHeads } from './workspace-preservation'

const head = (sha: string, role: WorkspacePreservationHead['role']) => ({
  sha,
  remoteRef: `refs/autobuild/archive/build/${sha}`,
  role,
  commits: [sha],
})
const replaced = 'a'.repeat(40)
const unpublished = 'b'.repeat(40)

test('a replaced branch head is demoted to a producer and reported', () => {
  expect(supersedeRestorationHeads([head(replaced, 'branch')], [replaced])).toEqual({
    restoration: [head(replaced, 'producer')],
    superseded: [replaced],
  })
})

test('unreplaced branch heads and producer heads are kept as recorded', () => {
  const heads = [head(unpublished, 'branch'), head(replaced, 'producer')]
  expect(supersedeRestorationHeads(heads, [replaced])).toEqual({
    restoration: heads,
    superseded: [],
  })
})

test('an absent preservation passes through', () => {
  expect(supersedeRestorationHeads(undefined, [replaced])).toEqual({
    restoration: undefined,
    superseded: [],
  })
})
