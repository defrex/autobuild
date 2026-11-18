import { describe, expect, test } from 'bun:test'
import { DISPATCHER, humanActor } from '../events/envelope'
import {
  commandMetric,
  commandObjective,
  OPTIMIZATION_SHA,
  OptimizationLogBuilder,
  panelObjective,
} from './generators/optimization-log'
import {
  baselineMeasurementDue,
  baselineSummary,
  decideSampledMeasurement,
  effectiveEpsilon,
  harnessDiff,
  measurementDecision,
  measurementDelta,
  median,
  noiseExceeded,
  parseLsTree,
  parseMeasurementOutput,
  pendingMeasurementRequest,
  sampledMeasurement,
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
      { mode: '100644', type: 'blob', path: 'bench/a b.json', object: '1'.repeat(40) },
      { mode: '160000', type: 'commit', path: 'vendor', object: '2'.repeat(40) },
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

describe('sampledMeasurement', () => {
  test('a request is the runner’s until sampled, then the dispatcher’s until decided', () => {
    const requested = attempt().requestMeasurement('m1')
    const sampled = requested.sampled('m1', { baseline: 50, candidate: 44 })
    const state = reduceBuild(sampled.events)
    expect(pendingMeasurementRequest(state)).toBeUndefined()
    expect(sampledMeasurement(state)).toMatchObject({
      request: 'm1',
      medians: { baseline: 50, candidate: 44 },
      report: { kind: 'measurement-samples', rev: 0 },
    })
    const measured = sampled.measured('m1', { baseline: 50, candidate: 44 })
    expect(sampledMeasurement(reduceBuild(measured.events))).toBeUndefined()
  })

  test('a newer request supersedes older samples', () => {
    const log = attempt()
      .requestMeasurement('m1')
      .sampled('m1', { baseline: 50, candidate: 44 })
      .requestMeasurement('m2')
    const state = reduceBuild(log.events)
    expect(sampledMeasurement(state)).toBeUndefined()
    expect(pendingMeasurementRequest(state)?.id).toBe('m2')
  })

  test('a refusal after sampling ends the dispatcher’s work for that request', () => {
    const log = attempt()
      .requestMeasurement('m1')
      .sampled('m1', { baseline: 50, candidate: 44 })
      .push({
        actor: DISPATCHER,
        type: 'escalation.raised',
        payload: {
          id: 'esc-1',
          phase: 'measurement',
          source: 'policy',
          policyCause: 'measurement-failed',
          question: 'q',
        },
      })
    const refused = log.push({
      actor: humanActor('ada'),
      type: 'escalation.answered',
      payload: { id: 'esc-1', answer: 'ok', resolution: 'guidance' },
    })
    const state = reduceBuild(refused.events)
    expect(state.attemptMeasurement?.refused).toBe('m1')
    expect(sampledMeasurement(state)).toBeUndefined()
    expect(pendingMeasurementRequest(state)).toBeUndefined()
  })

  test('a runner failure before sampling is not a refusal; the answer re-arms sampling', () => {
    const log = attempt()
      .requestMeasurement('m1')
      .push({
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
      .push({
        actor: humanActor('ada'),
        type: 'escalation.answered',
        payload: { id: 'esc-1', answer: 'retry', resolution: 'guidance' },
      })
    const state = reduceBuild(log.events)
    expect(state.attemptMeasurement?.refused).toBeUndefined()
    expect(pendingMeasurementRequest(state)?.id).toBe('m1')
  })

  test('none on a terminal leaf', () => {
    const log = attempt()
      .requestMeasurement('m1')
      .sampled('m1', { baseline: 50, candidate: 44 })
      .push({ actor: { kind: 'kernel' }, type: 'build.aborted', payload: {} })
    expect(sampledMeasurement(reduceBuild(log.events))).toBeUndefined()
  })
})

describe('decideSampledMeasurement', () => {
  const request = {
    id: 'm1',
    node: 'opt-node',
    candidate: OPTIMIZATION_SHA('c'),
    baseline: OPTIMIZATION_SHA('a'),
    harnessPin: OPTIMIZATION_SHA('a'),
    revision: 1,
    metric: commandMetric(),
  }
  const samples = (medians: { baseline: number; candidate: number }) =>
    sampledMeasurement(
      reduceBuild(attempt().requestMeasurement('m1').sampled('m1', medians).events),
    )!

  test('decides against the node’s current epsilon, with its spread beside the delta', () => {
    const measuring = opened().baseline(1, 50, 0.4)
    const sampled = samples({ baseline: 50, candidate: 48.8 })
    // ε is 3% of 50 = 1.5: a delta of 1.2 is no improvement.
    expect(decideSampledMeasurement(reduceBuild(measuring.events), request, sampled)).toEqual({
      measured: {
        request: 'm1',
        candidate: OPTIMIZATION_SHA('c'),
        baseline: OPTIMIZATION_SHA('a'),
        harnessPin: OPTIMIZATION_SHA('a'),
        revision: 1,
        samples: 7,
        medians: { baseline: 50, candidate: 48.8 },
        delta: expect.closeTo(1.2) as unknown as number,
        decision: 'no-improvement',
        spread: 0.4,
        report: { kind: 'measurement-samples', rev: 0 },
      },
    })
    // A quick revision while the samples ran applies: ε 1 accepts 1.2.
    const revised = measuring.revise({ epsilon: { absolute: 1 } }, 2)
    const decided = decideSampledMeasurement(reduceBuild(revised.events), request, sampled)
    expect('measured' in decided && decided.measured.decision).toBe('improved')
  })

  test('a maximizing objective mirrors the delta', () => {
    const objective = commandObjective({
      metric: { ...commandMetric(), direction: 'maximize' },
    })
    const node = reduceBuild(opened(objective).baseline(1, 50, 0).events)
    const decided = decideSampledMeasurement(
      node,
      { ...request, metric: objective.metric as ReturnType<typeof commandMetric> },
      samples({ baseline: 50, candidate: 52 }),
    )
    expect('measured' in decided && decided.measured).toMatchObject({
      delta: 2,
      decision: 'improved',
    })
  })

  test('a new ruler or harness pin after the request refuses instead of deciding', () => {
    const sampled = samples({ baseline: 50, candidate: 40 })
    const newRuler = opened()
      .baseline(1, 50, 0.4)
      .accept(
        commandObjective({ metric: { ...commandMetric(), command: 'bun bench/v2.ts' } }),
        2,
        1,
        OPTIMIZATION_SHA('b'),
      )
      .baseline(2, 50, 0.4)
    expect(decideSampledMeasurement(reduceBuild(newRuler.events), request, sampled)).toEqual({
      refusal: expect.stringContaining('older than the current ruler (revision 2)'),
    })
    const rePinned = opened()
      .baseline(1, 50, 0.4)
      .accept(commandObjective(), 2, 1, OPTIMIZATION_SHA('b'))
    expect(
      decideSampledMeasurement(reduceBuild(rePinned.events), { ...request, revision: 2 }, sampled),
    ).toEqual({ refusal: expect.stringContaining('pins the harness at') })
  })

  test('a panel, a missing objective, a missing starting value or another metric refuses', () => {
    const sampled = samples({ baseline: 50, candidate: 40 })
    const refusal = (node: ReturnType<typeof reduceBuild>, req = request) => {
      const decided = decideSampledMeasurement(node, req, sampled)
      return 'refusal' in decided ? decided.refusal : undefined
    }
    expect(refusal(reduceBuild(node().events))).toContain('no accepted objective')
    expect(refusal(reduceBuild(opened(panelObjective()).events))).toContain('panel')
    expect(refusal(reduceBuild(opened().events))).toContain('no starting measurement')
    expect(
      refusal(reduceBuild(opened().baseline(1, 50, 0).events), {
        ...request,
        metric: { ...commandMetric(), command: 'other' },
      }),
    ).toContain('differs from the node')
  })
})
