/** The optimization node's objective row (RFC 0005 §12): one projection from
 * the digest, one vocabulary on every surface. */
import { expect, test } from 'bun:test'
import { parseConfig } from '../../config/load'
import { DISPATCHER } from '../../events/envelope'
import type { AbEvent } from '../../events/catalog'
import {
  commandObjective,
  OptimizationLogBuilder,
  optimizationLog,
  panelObjective,
} from '../../kernel/generators/optimization-log'
import { reduceBuild } from '../../kernel/reducer'
import type { BuildRecord } from '../../store/types'
import { buildDashboardFromProjected, projectBuild, type DashboardModel } from './model'
import {
  objectiveElapsedHours,
  objectiveParts,
  objectiveSegments,
  objectiveSummary,
  projectObjectiveRow,
} from './objective-row'
import { renderDashboard, stripAnsi } from './render'

const config = parseConfig('[tickets]\nsource="file"\nreadyState="ready"')
const header = { repo: 'repo', queued: 0, activeCount: 1, capacity: 4 }
const now = Date.parse('2026-11-18T00:00:00Z')

const created: Parameters<OptimizationLogBuilder['push']>[0] = {
  actor: DISPATCHER,
  type: 'build.created',
  payload: {
    repo: 'repo',
    ticket: { source: 'file', id: 'node' },
    baseBranch: 'main',
    kind: 'node',
  },
}

function record(events: AbEvent[]): BuildRecord {
  return {
    slug: events[0]!.build,
    repo: 'repo',
    createdAt: events[0]!.ts,
    updatedAt: events.at(-1)!.ts,
  }
}

function model(events: AbEvent[]): DashboardModel {
  const row = projectBuild(record(events), reduceBuild(events), config, events)
  return buildDashboardFromProjected([row!], header)
}

function render(events: AbEvent[], width: number, detail = false): string[] {
  const frame = model(events)
  if (detail) frame.view = { kind: 'detail', slug: events[0]!.build, scroll: 0 }
  return renderDashboard(frame, { color: true, width, now }).map(stripAnsi)
}

test('a command objective projects every field from the digest', () => {
  const row = projectObjectiveRow(reduceBuild(optimizationLog()))!
  expect(row).toEqual({
    metric: 'command',
    direction: 'minimize',
    starting: 50,
    current: 44,
    threshold: 35,
    noise: 1.6,
    attempts: { filed: 4, accepted: 1, rejected: 3, running: 0 },
    budget: { maxAttempts: 60, maxHours: 24, openedAt: '2026-11-17T00:00:00.000Z' },
    stopped: { cause: 'plateau', mode: 'drain', at: '2026-11-17T00:00:00.000Z' },
  })
  expect(objectiveParts(row, 0)).toEqual([
    ['objective 50 → 44 (minimize)', 'threshold 35', 'noise ±1.6'],
    ['attempts 1 accepted', '3 rejected', '0 running'],
    ['budget 4/60 attempts', '0.0/24 hours'],
    ['stopped plateau (drain)'],
  ])
  expect(objectiveSegments(row, 0)).toEqual(
    objectiveParts(row, 0).map((parts) => parts.join(' · ')),
  )
})

test('a panel objective shows win rates, starting at one half', () => {
  // `panelOptimizationLog()` with the node's creation, which the row requires.
  const events = new OptimizationLogBuilder('panel-node')
    .push(created)
    .accept(panelObjective(), 1)
    .baseline(1, 0.55, 0.05)
    .propose('r1', ['p1'])
    .settle('p1', 'accepted', { revision: 1, baseline: 0.5, candidate: 0.7, delta: 0.2 })
    .progress(1, 0.7).events
  const row = projectObjectiveRow(reduceBuild(events))!
  expect(row.metric).toBe('panel')
  expect(row.starting).toBe(0.5)
  expect(objectiveSegments(row, 0)).toEqual([
    'win rate 50% → 70% · threshold 80% · noise ±5%',
    'attempts 1 accepted · 0 rejected · 0 running',
    'budget 1/10 attempts',
  ])
})

test('budget hours track the clock until the node stops, then freeze', () => {
  const running = new OptimizationLogBuilder()
    .push(created)
    .accept(commandObjective({ target: { epsilon: { relative: 0.03 } } }), 1)
  const row = projectObjectiveRow(reduceBuild(running.events))!
  expect(objectiveSegments(row, 0)[0]).toBe('objective not measured · no threshold')
  expect(objectiveElapsedHours(row, new Date('2026-11-17T03:00:00Z'))).toBe(3)
  expect(objectiveElapsedHours(row, new Date('2026-11-16T00:00:00Z'))).toBe(0)
  const stopped = projectObjectiveRow(
    reduceBuild(running.wait(90).stop('operator', 'abort').events),
  )!
  expect(objectiveElapsedHours(stopped, new Date('2026-11-18T00:00:00Z'))).toBe(1.5)
  expect(objectiveSummary(reduceBuild(running.events), new Date(now))?.elapsedHours).toBe(1.5)
})

test('a plain node and a work build have no objective row', () => {
  const plain = new OptimizationLogBuilder('plain-node').push(created).events
  expect(projectObjectiveRow(reduceBuild(plain))).toBeUndefined()
  expect(projectObjectiveRow(reduceBuild([]))).toBeUndefined()
  expect(objectiveSummary(reduceBuild([]), new Date(now))).toBeUndefined()
  const row = model(plain).builds[0]!
  expect(row).not.toHaveProperty('objectiveRow')
  for (const detail of [false, true]) {
    const text = render(plain, 80, detail).join('\n')
    for (const term of ['Objective', 'objective', 'accepted', 'budget', 'noise'])
      expect(text).not.toContain(term)
  }
})

test('the terminal dashboard renders the row and the detail field', () => {
  const events = optimizationLog()
  expect(model(events).builds[0]!.objectiveRow).toEqual(projectObjectiveRow(reduceBuild(events))!)
  const list = render(events, 120)
  const bar = list.findIndex((line) => line.includes('children unknown'))
  expect(list[bar + 1]).toBe(
    '   objective 50 → 44 (minimize) · threshold 35 · noise ±1.6 · attempts 1 accepted · 3 rejected · 0 running ·',
  )
  expect(list.join('\n')).toContain('stopped plateau (drain)')
  const detail = render(events, 120, true)
  expect(detail.find((line) => line.includes('Objective'))).toStartWith(
    '   Objective objective 50 → 44 (minimize)',
  )
})

test('narrow frames wrap large values between fields without truncating any', () => {
  const events = new OptimizationLogBuilder()
    .push(created)
    .accept(commandObjective(), 1)
    .baseline(1, 123456.123456, 1.5)
    .revise({ threshold: 100000 }, 2)
    .propose('r1', ['a1'])
    .settle('a1', 'accepted', {
      revision: 2,
      baseline: 123456.123456,
      candidate: 123450.123456,
      delta: 6,
    })
    .stop('threshold', 'abort').events
  const row = projectObjectiveRow(reduceBuild(events))!
  expect(objectiveSegments(row, 0)[0]!.length).toBeGreaterThanOrEqual(80)
  for (const width of [40, 60])
    for (const detail of [false, true]) {
      const lines = render(events, width, detail)
      const first = lines.findIndex((line) => line.includes(detail ? 'Objective' : 'objective'))
      const last = lines.findIndex((line) => line.includes('stopped threshold (abort)'))
      expect(first).toBeGreaterThan(-1)
      expect(last).toBeGreaterThanOrEqual(first)
      const objective = lines.slice(first, last + 1)
      for (const line of objective) {
        expect(line.length).toBeLessThanOrEqual(width)
        expect(line).not.toContain('~')
      }
      const joined = objective.join(' ')
      let at = 0
      for (const term of [
        'objective',
        '123456.123456',
        '→',
        '123450.123456',
        '(minimize)',
        'threshold',
        '100000',
        'noise',
        '±1.5',
        '1 accepted',
        '0 rejected',
        '0 running',
        'budget 1/60 attempts',
        '0.0/24 hours',
        'stopped threshold (abort)',
      ]) {
        const next = joined.indexOf(term, at)
        expect(next).toBeGreaterThanOrEqual(at)
        at = next + term.length
      }
    }
})
