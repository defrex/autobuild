/** `ab status` labels an optimization node as one (SPEC §13.1). */
import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import { commandObjective } from '../kernel/generators/optimization-log'
import { MemoryBuildStore } from '../store/memory'
import { buildVocabulary } from './dashboard/model'
import { reduceBuild } from '../kernel/reducer'
import { detail, renderDetail, renderSummaries, summarize } from './status'

const now = new Date('2026-11-17T00:00:00Z')

async function node(optimization: boolean) {
  const store = new MemoryBuildStore()
  const record = await store.createBuild({ slug: 'node', repo: '/repo', branch: 'ab-node/node' })
  await store.append(record.slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'file', id: 'N-1' },
      repo: '/repo',
      baseBranch: 'main',
      kind: 'node',
    },
  })
  if (optimization)
    await store.append(record.slug, {
      actor: DISPATCHER,
      type: 'optimization.objective-accepted',
      payload: {
        objective: commandObjective(),
        revision: 1,
        harnessPin: 'a'.repeat(40),
        specRev: 0,
      },
    })
  await store.append(record.slug, {
    actor: DISPATCHER,
    type: 'node.opened',
    payload: { sha: 'a'.repeat(40) },
  })
  return { record, events: await store.getEvents(record.slug) }
}

test('an optimization node is labeled in the summary and the detail', async () => {
  const { record, events } = await node(true)
  const summary = summarize(record, events, now)
  expect(summary.optimization).toBe(true)
  expect(summary.objectiveRevision).toBe(1)
  expect(renderSummaries([summary], now, '').join('\n')).toContain('optimization node empty')
  expect(renderDetail(detail(record, events, now), now)).toContain(
    '  optimization node: objective revision 1',
  )
})

test('a plain node and a work build project exactly as before', async () => {
  const { record, events } = await node(false)
  const summary = summarize(record, events, now)
  expect(summary).not.toHaveProperty('optimization')
  expect(summary).not.toHaveProperty('objectiveRevision')
  expect(renderSummaries([summary], now, '').join('\n')).toContain('integration empty')
  expect(buildVocabulary(reduceBuild(events))).not.toHaveProperty('optimization')
  expect(buildVocabulary(reduceBuild([]))).toEqual({ kind: 'work' })
})
