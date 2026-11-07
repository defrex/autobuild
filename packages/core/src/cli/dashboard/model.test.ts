import { expect, test } from 'bun:test'
import { decorateSlotWaits, type DashboardBuild } from './model'
import type { DispatchCapacity } from '../../kernel/dispatch-capacity'

function node(slug: string, alert?: { tone: 'red' | 'yellow'; text: string }): DashboardBuild {
  return {
    slug,
    integrationRow: {
      destination: 'main',
      children: { known: false },
      verified: false,
      steps: [],
      openChildren: [],
      ...(alert ? { alert } : {}),
    },
  } as unknown as DashboardBuild
}

const capacity: DispatchCapacity = {
  configured: 2,
  occupied: 2,
  effective: 2,
  borrowingNodes: [],
  waitingNodes: [
    { slug: 'waiting', request: 'verification' },
    { slug: 'conflicted', request: 'reconcile' },
  ],
}

test('a waiting node row says it waits for a slot; red alerts and input rows are kept', () => {
  const conflict = { tone: 'red' as const, text: 'restack conflict' }
  const rows = [node('waiting'), node('conflicted', conflict), node('idle')]
  const before = structuredClone(rows)
  const decorated = decorateSlotWaits(rows, capacity)
  expect(decorated[0]!.integrationRow!.alert).toEqual({
    tone: 'yellow',
    text: 'verification waiting for a slot ahead of new ticket claims',
  })
  expect(decorated[1]!.integrationRow!.alert).toEqual(conflict)
  expect(decorated[2]).toBe(rows[2]!)
  expect(rows).toEqual(before)
})

test('a legacy capacity projection without waiting nodes decorates nothing', () => {
  const rows = [node('waiting')]
  const { waitingNodes: _, ...legacy } = capacity
  expect(decorateSlotWaits(rows, legacy)).toEqual(rows)
  expect(decorateSlotWaits(rows, undefined)).toEqual(rows)
})
