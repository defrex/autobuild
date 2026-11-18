import { describe, expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../events/envelope'
import {
  commandObjective,
  OPTIMIZATION_SHA,
  OptimizationLogBuilder,
  panelObjective,
} from './generators/optimization-log'
import {
  baselineMeasurementDue,
  baselineSummary,
  effectiveEpsilon,
  harnessDiff,
  measurementDecision,
  measurementDelta,
  median,
  noiseExceeded,
  parseLsTree,
  parseMeasurementOutput,
  pendingMeasurementRequest,
  sampleOrder,
  type TreeEntry,
} from './measurement'
import { reduceBuild } from './reducer'

function node(): OptimizationLogBuilder {
  return new OptimizationLogBuilder().push({
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      repo: 'repo',
      ticket: { source: 'file', id: 'node' },
      baseBranch: 'main',
      kind: 'node',
    },
  })
}

function opened(objective = commandObjective()): OptimizationLogBuilder {
  return node()
    .accept(objective, 1)
    .push({ actor: DISPATCHER, type: 'node.opened', payload: { sha: OPTIMIZATION_SHA('a') } })
}

function attempt(): OptimizationLogBuilder {
  return new OptimizationLogBuilder('attempt-a1').push({
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      repo: 'repo',
      ticket: { source: 'file', id: 'T-a1' },
      baseBranch: 'ab/opt-node',
      kind: 'work',
    },
  })
}

describe('measurement math', () => {
  test('median of odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(() => median([])).toThrow()
  })

  test('delta is positive for an improvement in either direction', () => {
    expect(measurementDelta('minimize', 50, 44)).toBe(6)
    expect(measurementDelta('minimize', 44, 50)).toBe(-6)
    expect(measurementDelta('maximize', 44, 50)).toBe(6)
    expect(measurementDelta('maximize', 50, 44)).toBe(-6)
  })

  test('effective epsilon is absolute or relative to the baseline magnitude', () => {
    expect(effectiveEpsilon({ absolute: 2 }, 50)).toBe(2)
    expect(effectiveEpsilon({ relative: 0.1 }, 50)).toBeCloseTo(5)
    expect(effectiveEpsilon({ relative: 0.1 }, -50)).toBeCloseTo(5)
    expect(effectiveEpsilon({ relative: 0.1 }, 0)).toBe(0)
  })

  test('a delta equal to epsilon improves; a smaller positive one does not', () => {
    expect(measurementDecision(2, 2)).toBe('improved')
    expect(measurementDecision(1.5, 2)).toBe('no-improvement')
    expect(measurementDecision(-1, 2)).toBe('no-improvement')
  })

  test('noise exceeds epsilon only strictly', () => {
    expect(noiseExceeded(2, 2)).toBe(false)
    expect(noiseExceeded(1.9, 2)).toBe(true)
    expect(noiseExceeded(0, 0)).toBe(false)
    expect(noiseExceeded(0, 0.1)).toBe(true)
  })

  test('the baseline summary is the median of every sample with the medians’ distance as spread', () => {
    expect(baselineSummary([10, 12, 11], [13, 12, 14])).toEqual({ median: 12, spread: 2 })
    expect(baselineSummary([-1], [1])).toEqual({ median: 0, spread: 2 })
  })

  test('sample order alternates which side runs first', () => {
    expect(sampleOrder(3)).toEqual([
      ['baseline', 'candidate'],
      ['candidate', 'baseline'],
      ['baseline', 'candidate'],
    ])
  })
})

describe('measurement output contract', () => {
  test('accepts exactly one object with a finite numeric value', () => {
    expect(parseMeasurementOutput('{"value": 41.5}\n')).toEqual({ value: 41.5 })
    expect(parseMeasurementOutput('  {"value": -2, "unit": "ms"}  ')).toEqual({ value: -2 })
  })

  test.each([
    ['empty', ''],
    ['a string value', '{"value":"1"}'],
    ['an array', '[1]'],
    ['two JSON lines', '{"value":1}\n{"value":2}'],
    ['trailing text', '{"value":1} done'],
    ['NaN', '{"value":NaN}'],
    ['Infinity', '{"value":Infinity}'],
    ['an overflowing number', '{"value":1e999}'],
    ['null', 'null'],
    ['no value', '{"v":1}'],
  ])('refuses %s', (_name, output) => {
    expect('refusal' in parseMeasurementOutput(output)).toBe(true)
  })
})

describe('harness diff', () => {
  const blob = (path: string): TreeEntry => ({ mode: '100644', type: 'blob', path })
  const link = (path: string): TreeEntry => ({ mode: '120000', type: 'blob', path })
  const module = (path: string): TreeEntry => ({ mode: '160000', type: 'commit', path })

  test('restores every pinned harness file and removes harness files the pin lacks', () => {
    const pin = [
      blob('bench/run.sh'),
      blob('bench/fixture.json'),
      link('bench/data'),
      blob('src/a.ts'),
    ]
    const head = [
      blob('bench/run.sh'),
      blob('bench/added.json'),
      blob('src/a.ts'),
      blob('src/new.ts'),
      module('bench/vendor'),
    ]
    expect(harnessDiff(pin, head, ['bench/**'])).toEqual({
      restore: ['bench/run.sh', 'bench/fixture.json', 'bench/data'],
      remove: ['bench/added.json'],
    })
  })

  test('parses NUL-separated ls-tree output, including paths with spaces', () => {
    const output =
      '100644 blob 1111111111111111111111111111111111111111\tbench/a b.json\0' +
      '160000 commit 2222222222222222222222222222222222222222\tvendor\0'
    expect(parseLsTree(output)).toEqual([
      { mode: '100644', type: 'blob', path: 'bench/a b.json' },
      { mode: '160000', type: 'commit', path: 'vendor' },
    ])
  })
})

describe('baselineMeasurementDue', () => {
  test('an opened command node without a starting value is due', () => {
    expect(baselineMeasurementDue(reduceBuild(opened().events))).toBe(true)
  })

  test('not before the node opens, nor once the starting value is recorded', () => {
    expect(baselineMeasurementDue(reduceBuild(node().accept(commandObjective(), 1).events))).toBe(
      false,
    )
    expect(baselineMeasurementDue(reduceBuild(opened().baseline(1, 50, 1).events))).toBe(false)
  })

  test('a new ruler clears the starting value and makes it due again', () => {
    const changed = commandObjective()
    if (changed.metric.kind === 'command') changed.metric.command = 'bun bench/other.ts'
    const log = opened().baseline(1, 50, 1).accept(changed, 2, 1, OPTIMIZATION_SHA('b'))
    expect(baselineMeasurementDue(reduceBuild(log.events))).toBe(true)
  })

  test('a quick revision keeps the starting value', () => {
    const log = opened()
      .baseline(1, 50, 1)
      .revise({ epsilon: { absolute: 3 } }, 2)
    expect(baselineMeasurementDue(reduceBuild(log.events))).toBe(false)
  })

  test('a panel, a stopped node, a paused or blocked node and a terminal node are never due', () => {
    expect(baselineMeasurementDue(reduceBuild(opened(panelObjective()).events))).toBe(false)
    expect(baselineMeasurementDue(reduceBuild(opened().stop('operator', 'abort').events))).toBe(
      false,
    )
    const paused = opened()
      .push({ actor: humanActor('ada'), type: 'build.pause-requested', payload: {} })
      .push({ actor: { kind: 'kernel' }, type: 'build.paused', payload: {} })
    expect(baselineMeasurementDue(reduceBuild(paused.events))).toBe(false)
    const blocked = opened().push({
      actor: { kind: 'kernel' },
      type: 'escalation.raised',
      payload: {
        id: 'esc-1',
        phase: 'measurement',
        source: 'policy',
        policyCause: 'measurement-failed',
        question: 'q',
      },
    })
    expect(baselineMeasurementDue(reduceBuild(blocked.events))).toBe(false)
    const answered = blocked.push({
      actor: humanActor('ada'),
      type: 'escalation.answered',
      payload: { id: 'esc-1', answer: 'retry', resolution: 'guidance' },
    })
    expect(baselineMeasurementDue(reduceBuild(answered.events))).toBe(true)
    const aborted = opened().push({ actor: { kind: 'kernel' }, type: 'build.aborted', payload: {} })
    expect(baselineMeasurementDue(reduceBuild(aborted.events))).toBe(false)
  })
})

describe('pendingMeasurementRequest', () => {
  test('the latest unmeasured request on a leaf', () => {
    const log = attempt().requestMeasurement('m1')
    expect(pendingMeasurementRequest(reduceBuild(log.events))).toEqual({
      id: 'm1',
      node: 'opt-node',
      candidate: OPTIMIZATION_SHA('c'),
      baseline: OPTIMIZATION_SHA('a'),
      harnessPin: OPTIMIZATION_SHA('a'),
      revision: 1,
    })
  })

  test('none once measured; a newer request is pending again', () => {
    const measured = attempt()
      .requestMeasurement('m1')
      .measured('m1', { baseline: 50, candidate: 44 })
    expect(pendingMeasurementRequest(reduceBuild(measured.events))).toBeUndefined()
    expect(
      pendingMeasurementRequest(reduceBuild(measured.requestMeasurement('m2').events))?.id,
    ).toBe('m2')
  })

  test('none on a terminal leaf or a node', () => {
    const aborted = attempt()
      .requestMeasurement('m1')
      .push({ actor: { kind: 'kernel' }, type: 'build.aborted', payload: {} })
    expect(pendingMeasurementRequest(reduceBuild(aborted.events))).toBeUndefined()
    expect(
      pendingMeasurementRequest(reduceBuild(opened().requestMeasurement('m1').events)),
    ).toBeUndefined()
  })
})
