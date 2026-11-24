import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { guestTicketSourceArgs } from './harvest-child'

test('a local-path store ref selects the resolved store ref as the guest local state root', () => {
  const workspace = '/synthetic/checkout'
  const args = guestTicketSourceArgs(
    {
      storeRef: 'state-store',
      repo: '/repo',
      instance: 'host-harvest-i1',
      baseBranch: 'main',
      supervision: { kind: 'environment' },
    },
    workspace,
  )
  expect(args.localStateRoot).toBe(resolve(workspace, 'state-store'))
})
