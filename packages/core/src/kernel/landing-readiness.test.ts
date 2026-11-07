import { describe, expect, test } from 'bun:test'
import type { AbEvent, EventWrite } from '../events/catalog'
import { validateEventWrite } from '../events/catalog'
import { DISPATCHER, KERNEL, agentActor } from '../events/envelope'
import type { LeafRestackState } from './leaf-restack-state'
import { landPreconditions, landRefusalReason } from './landing-readiness'
import { buildReducer } from './reducer'

const event = (seq: number, write: EventWrite): AbEvent =>
  ({
    ...validateEventWrite(write),
    build: 'test',
    seq,
    ts: new Date(0).toISOString(),
  }) as AbEvent
const finalized = (head = 'head'): EventWrite => ({
  actor: KERNEL,
  type: 'finalize.completed',
  payload: { pr: { number: 1, url: 'https://forge/1', headSha: head } },
})
const decided = (head = 'head'): EventWrite => ({
  actor: DISPATCHER,
  type: 'landing.decided',
  payload: {
    candidate: { head, parent: 'base', cycle: '1' },
    from: 'leaf',
    into: { kind: 'root' },
    labels: [],
    mode: 'consent',
    rule: { default: true },
  },
})
const reduce = (...writes: EventWrite[]) =>
  buildReducer.reduce(writes.map((write, i) => event(i + 1, write)))
const idle: LeafRestackState = { gates: {} }

describe('land refusal reasons', () => {
  const cases: Array<{
    name: string
    writes: EventWrite[]
    restack?: LeafRestackState
    reason: string | undefined
  }> = [
    { name: 'ready leaf candidate', writes: [finalized(), decided()], reason: undefined },
    {
      name: 'no decision',
      writes: [finalized()],
      reason: 'no merge candidate has been decided yet',
    },
    {
      name: 'paused',
      writes: [finalized(), decided(), { actor: KERNEL, type: 'build.paused', payload: {} }],
      reason: 'the build is paused',
    },
    {
      name: 'open escalation',
      writes: [
        finalized(),
        decided(),
        {
          actor: agentActor('implement', 'session-1'),
          type: 'escalation.raised',
          payload: { id: 'esc', phase: 'implement', round: 1, source: 'agent', question: 'Q?' },
        },
      ],
      reason: 'the build has open escalations to answer',
    },
    {
      name: 'stale head',
      writes: [finalized('newer'), decided()],
      reason: "the merge candidate's head is stale",
    },
    {
      name: 'active restack',
      writes: [finalized(), decided()],
      restack: { gates: {}, active: {} as NonNullable<LeafRestackState['active']> },
      reason: 'a restack is in progress',
    },
  ]
  for (const item of cases)
    test(item.name, () => {
      const state = reduce(...item.writes)
      const restack = item.restack ?? idle
      expect(landRefusalReason(state, restack)).toBe(item.reason)
      expect(landPreconditions(state, restack)).toBe(item.reason === undefined)
    })
})
