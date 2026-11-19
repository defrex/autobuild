/** `ab status` labels an optimization node as one (SPEC §13.1). */
import { expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import {
  commandObjective,
  OPTIMIZATION_SHA,
  OptimizationLogBuilder,
  panelObjective,
} from '../kernel/generators/optimization-log'
import { MemoryBuildStore } from '../store/memory'
import { buildVocabulary } from './dashboard/model'
import { objectiveSegments, objectiveSummary } from './dashboard/objective-row'
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

test('an optimization node carries its objective progress on every status surface', async () => {
  const { record, events } = await node(true)
  const summary = summarize(record, events, now)
  expect(summary.objective).toEqual(objectiveSummary(reduceBuild(events), now))
  const segments = objectiveSegments(summary.objective!, summary.objective!.elapsedHours)
  expect(segments).toEqual([
    'objective not measured · threshold 40',
    'attempts 0 accepted · 0 rejected · 0 running',
    'budget 0/60 attempts · 0.0/24 hours',
  ])
  const plain = summarize(record, (await node(false)).events, now)
  const table = renderSummaries([summary, plain], now, '')
  expect(table).toHaveLength(4)
  expect(table[1]).toStartWith('node ')
  expect(table[2]).toBe(`    ${segments.join(' · ')}`)
  expect(table[3]).toStartWith('node ')
  expect(table[3]).toContain('integration empty')
  const lines = renderDetail(detail(record, events, now), now)
  const label = lines.indexOf('  optimization node: objective revision 1')
  expect(lines.slice(label + 1, label + 1 + segments.length)).toEqual(
    segments.map((segment) => `    ${segment}`),
  )
  expect(detail(record, events, now).objective).toEqual(summary.objective)
})

test('a plain node and a work build project exactly as before', async () => {
  const { record, events } = await node(false)
  const summary = summarize(record, events, now)
  expect(summary).not.toHaveProperty('optimization')
  expect(summary).not.toHaveProperty('objectiveRevision')
  expect(summary).not.toHaveProperty('objective')
  expect(detail(record, events, now)).not.toHaveProperty('objective')
  const table = renderSummaries([summary], now, '')
  expect(table).toHaveLength(2)
  expect(table.join('\n')).toContain('integration empty')
  expect(buildVocabulary(reduceBuild(events))).not.toHaveProperty('optimization')
  expect(buildVocabulary(reduceBuild([]))).toEqual({ kind: 'work' })
})

async function measuredAttempt(panel: boolean) {
  const store = new MemoryBuildStore()
  const record = await store.createBuild({ slug: 'attempt-a1', repo: '/repo', branch: 'ab/a1' })
  const log = new OptimizationLogBuilder('attempt-a1')
    .push({
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket: { source: 'file', id: 'T-a1' }, repo: '/repo', baseBranch: 'ab/node' },
    })
    .requestMeasurement(
      'm1',
      'node',
      1,
      undefined,
      (panel ? panelObjective() : commandObjective()).metric,
    )
  if (panel)
    log.push({
      actor: DISPATCHER,
      type: 'attempt.measured',
      payload: {
        request: 'm1',
        candidate: OPTIMIZATION_SHA('c'),
        baseline: OPTIMIZATION_SHA('a'),
        harnessPin: OPTIMIZATION_SHA('a'),
        revision: 1,
        samples: 5,
        winRate: 0.8,
        delta: 0.3,
        decision: 'improved',
      },
    })
  else log.measured('m1', { baseline: 50, candidate: 44 }, { spread: 0.4 })
  return { record, events: log.events }
}

test('an attempt shows its recorded win rate or medians in status', async () => {
  const panel = await measuredAttempt(true)
  const summary = summarize(panel.record, panel.events, now)
  expect(summary.measurement).toEqual({
    candidate: OPTIMIZATION_SHA('c'),
    baseline: OPTIMIZATION_SHA('a'),
    revision: 1,
    delta: 0.3,
    decision: 'improved',
    winRate: 0.8,
  })
  expect(renderDetail(detail(panel.record, panel.events, now), now)).toContain(
    `  measurement: win rate 0.8: delta 0.3 → improved (candidate ${'c'.repeat(7)} on ${'a'.repeat(7)})`,
  )
  const command = await measuredAttempt(false)
  expect(summarize(command.record, command.events, now).measurement).toMatchObject({
    medians: { baseline: 50, candidate: 44 },
    spread: 0.4,
  })
  expect(renderDetail(detail(command.record, command.events, now), now)).toContain(
    `  measurement: candidate 44 vs baseline 50: delta 6 (noise ±0.4) → improved (candidate ${'c'.repeat(7)} on ${'a'.repeat(7)})`,
  )
  const { record, events } = await node(true)
  expect(summarize(record, events, now)).not.toHaveProperty('measurement')
})
