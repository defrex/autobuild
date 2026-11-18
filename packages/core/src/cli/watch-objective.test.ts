/** `ab watch` carries an optimization node's objective progress (RFC 0005 §12). */
import { expect, test } from 'bun:test'
import { optimizationLog } from '../kernel/generators/optimization-log'
import { reduceBuild } from '../kernel/reducer'
import { objectiveSegments, objectiveSummary } from './dashboard/objective-row'
import { projectRecord, renderWatchLine } from './watch'

test('a node record carries the objective as of its own timestamp', () => {
  const events = optimizationLog()
  const at = events.findIndex((event) => event.type === 'attempt.settled')
  const event = events[at]!
  const state = reduceBuild(events.slice(0, at + 1))
  const record = projectRecord(event, state, 'cursor')
  const objective = objectiveSummary(state, new Date(event.ts))!
  expect(record.state?.objective).toEqual(objective)
  expect(projectRecord(event, state, 'cursor')).toEqual(record)
  expect(objective.attempts).toEqual({ filed: 3, accepted: 1, rejected: 0, running: 2 })
  expect(renderWatchLine(event, state)).toEndWith(
    `  — ${objectiveSegments(objective, objective.elapsedHours).join(' · ')}`,
  )
  const opened = events.find((event) => event.type === 'node.opened')!
  expect(renderWatchLine(opened, state)).not.toContain('—')
})

test('a work build record has no objective', () => {
  const events = optimizationLog()
  const state = reduceBuild([])
  const record = projectRecord(events[0]!, state, 'cursor')
  expect(record.state).not.toHaveProperty('objective')
  expect(renderWatchLine(events[0]!, state)).not.toContain('objective')
})
