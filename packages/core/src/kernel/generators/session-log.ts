/** Seeded generated session logs, with `session.archived` optionally mid-log. */
import { agentActor, humanActor } from '../../events/envelope'
import type { SessionEvent } from '../../events/sessions'
import { pick, seededRandom } from '../incremental-contract'

type Spec = { type: SessionEvent['type']; payload: Record<string, unknown>; human?: boolean }

export function randomSessionLog(seed: number, length: number, archive: boolean): SessionEvent[] {
  const rand = seededRandom(seed)
  const specs: Spec[] = [{ type: 'session.created', payload: {}, human: true }]
  for (let i = 0; i < length; i++) {
    const turn = pick(rand, ['t1', 't2', 't3'])
    const toolCallId = pick(rand, ['c1', 'c2'])
    const templates: Spec[] = [
      { type: 'message.posted', payload: { text: 'hi' }, human: true },
      {
        type: 'session.wake-set',
        payload: { globs: [pick(rand, ['a*', 'b*', 'c*'])] },
        human: true,
      },
      {
        type: 'turn.started',
        payload: {
          turn,
          stream: `st_${turn}`,
          trigger: pick(rand, [
            { kind: 'message', messageSeq: 1 },
            {
              kind: 'wake',
              build: pick(rand, ['b1', 'b2']),
              seq: 1 + Math.floor(rand() * 9),
              type: 'x',
            },
            { kind: 'wake', journal: true, seq: 1 + Math.floor(rand() * 9), type: 'x' },
          ]),
        },
      },
      { type: 'turn.suspended', payload: { turn, cause: pick(rand, ['budget', 'approval']) } },
      { type: 'turn.resumed', payload: { turn } },
      {
        type: 'approval.requested',
        payload: { turn, toolCallId, toolName: 'tool', input: { a: 1 } },
      },
      {
        type: 'approval.answered',
        payload: { turn, toolCallId, decision: 'approve' },
        human: true,
      },
      {
        type: 'turn.completed',
        payload: { turn, usage: { inputTokens: 1, outputTokens: 2, steps: 3 } },
      },
      { type: 'turn.failed', payload: { turn, kind: 'internal', error: 'boom' } },
    ]
    specs.push(pick(rand, templates))
  }
  if (archive) {
    const at = 1 + Math.floor(rand() * specs.length)
    specs.splice(at, 0, { type: 'session.archived', payload: {}, human: true })
  }
  return specs.map(
    (spec, index) =>
      ({
        session: 's_1',
        seq: index + 1,
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        actor: spec.human ? humanActor('aron') : agentActor('orchestrator', 's_a'),
        type: spec.type,
        payload: spec.payload,
      }) as unknown as SessionEvent,
  )
}
