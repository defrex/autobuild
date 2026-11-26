/** `ab build status` names the tickets a waiting build waits on (SPEC §11 "Ticket waits"). */
import { expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import { detail, renderDetail, renderSummaries } from './status'

async function waiting(stage: 'requested' | 'waiting' | 'ended' | 'blocked' | 'restacked') {
  const store = new MemoryBuildStore({ clock: steppingClock() })
  const record = await store.createBuild({ slug: 'waits', repo: '/repo' })
  await store.append(record.slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'file', id: 'A' }, repo: '/repo', baseBranch: 'main' },
  })
  await store.append(record.slug, {
    actor: { kind: 'agent', role: 'implement', session: 's_impl' },
    type: 'wait.requested',
    payload: { id: 'wait_1', phase: 'implement', round: 1, tickets: ['B', 'C'], reason: 'needs B' },
  })
  if (stage !== 'requested')
    await store.append(record.slug, {
      actor: DISPATCHER,
      type: 'wait.entered',
      payload: {
        id: 'wait_1',
        escalation: 'esc_w',
        tickets: [
          { source: 'file', id: 'B' },
          { source: 'file', id: 'C' },
        ],
        reason: 'needs B',
        question: 'Waiting on B, C to complete: needs B.',
      },
    })
  if (stage === 'blocked')
    await store.append(record.slug, {
      actor: DISPATCHER,
      type: 'escalation.raised',
      payload: {
        id: 'esc_other',
        phase: 'implement',
        round: 1,
        source: 'policy',
        policyCause: 'execution-no-progress',
        question: 'other question',
      },
    })
  if (stage === 'ended' || stage === 'restacked')
    await store.append(record.slug, {
      actor: humanActor('aron'),
      type: 'escalation.answered',
      payload: { id: 'esc_w', answer: 'B landed', resolution: 'guidance' },
    })
  if (stage === 'restacked') {
    const moved = await store.append(record.slug, {
      actor: DISPATCHER,
      type: 'target.moved',
      payload: { branch: 'main', sha: '2'.repeat(40) },
    })
    await store.append(record.slug, {
      actor: { kind: 'kernel' },
      type: 'restack.advanced',
      payload: {
        trigger: 'wait-resume',
        cycle: moved.seq - 1,
        observation: moved.seq,
        branch: 'ab/waits',
        from: '1'.repeat(40),
        to: '2'.repeat(40),
      },
    })
  }
  const now = new Date('2026-11-16T00:00:00Z')
  const shown = detail(record, await store.getEvents(record.slug), now)
  return { shown, lines: renderDetail(shown, now), rows: renderSummaries([shown], now, '') }
}

test('a requested wait awaits the dispatcher check', async () => {
  const { shown, lines } = await waiting('requested')
  expect(shown.wait).toEqual({
    state: 'requested',
    id: 'wait_1',
    tickets: ['B', 'C'],
    reason: 'needs B',
  })
  expect(lines).toContain('  waiting:  wait requested on B, C: awaiting dispatcher check')
})

test('an open wait names its tickets and how to end it early', async () => {
  const { shown, lines } = await waiting('waiting')
  expect(shown.wait).toMatchObject({ state: 'waiting', escalation: 'esc_w', tickets: ['B', 'C'] })
  const line = lines.find((entry) => entry.startsWith('  waiting on: '))
  expect(line).toContain('B, C — needs B (since ')
  expect(line).toContain('end early with ab answer waits)')
  expect(lines).toContain('  status:   waiting')
})

test('ab builds lists a lone open wait as waiting on its tickets; JSON keeps blocked', async () => {
  const { shown, rows } = await waiting('waiting')
  expect(shown.status).toBe('blocked')
  expect(shown.waitOnly).toBe(true)
  expect(JSON.parse(JSON.stringify(shown)).wait).toMatchObject({
    state: 'waiting',
    tickets: ['B', 'C'],
  })
  const row = rows[1]!.split(/\s{2,}/)
  expect(row[1]).toBe('waiting')
  // A build waiting on the outside world holds no slot and requests none.
  expect(row[2]).toBe('none')
  expect(row[3]).toEndWith(', waiting on B, C')
})

test('another open escalation keeps an open wait blocked', async () => {
  const { shown, rows, lines } = await waiting('blocked')
  expect(shown.waitOnly).toBeUndefined()
  expect(shown.wait).toMatchObject({ state: 'waiting' })
  expect(rows[1]!.split(/\s{2,}/)[1]).toBe('blocked')
  expect(rows[1]).toContain('waiting on B, C')
  expect(lines).toContain('  status:   blocked')
})

test('an ended wait waits for a slot to resume', async () => {
  const { shown, lines } = await waiting('ended')
  expect(shown.wait).toMatchObject({ state: 'ended', cause: 'operator' })
  expect(lines).toContain('  waiting:  wait on B, C ended (operator); resume waiting for a slot')
})

test('a wait-resume restack shows why it ran', async () => {
  const { shown, lines } = await waiting('restacked')
  expect(shown.restack).toEqual({ trigger: 'wait-resume', state: 'advanced', onto: '2'.repeat(40) })
  expect(lines).toContain('  restack:  wait-resume onto 2222222 — advanced')
  expect(shown.wait).toBeUndefined()
})
