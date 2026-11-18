import { describe, expect, test } from 'bun:test'
import { PanelLogBuilder, panelStarted } from './generators/panel-log'
import {
  advancePanel,
  awaitingReclaim,
  candidateScore,
  completable,
  countedFailures,
  drawOrder,
  judgments,
  labelSides,
  PANEL_JUDGE_ATTEMPTS,
  panelWinRate,
  pendingJudges,
  type PanelRunState,
} from './panel'
import { reduceBuild } from './reducer'

function fold(log: PanelLogBuilder): PanelRunState {
  let run: PanelRunState | undefined
  for (const event of log.events) run = advancePanel(run, event)
  if (run === undefined) throw new Error('no panel run')
  return run
}

describe('panel order and scoring', () => {
  test('the order is drawn from the random source', () => {
    expect(drawOrder(() => 0)).toBe('candidate-first')
    expect(drawOrder(() => 0.49)).toBe('candidate-first')
    expect(drawOrder(() => 0.5)).toBe('baseline-first')
    expect(drawOrder(() => 0.99)).toBe('baseline-first')
  })

  test('labels map to sides under both orders', () => {
    expect(labelSides('candidate-first')).toEqual({ A: 'candidate', B: 'baseline' })
    expect(labelSides('baseline-first')).toEqual({ A: 'baseline', B: 'candidate' })
  })

  test('every preference scores the candidate under both orders', () => {
    expect(candidateScore('candidate-first', 'A')).toBe(1)
    expect(candidateScore('candidate-first', 'B')).toBe(0)
    expect(candidateScore('baseline-first', 'A')).toBe(0)
    expect(candidateScore('baseline-first', 'B')).toBe(1)
    expect(candidateScore('candidate-first', 'tie')).toBe(0.5)
    expect(candidateScore('baseline-first', 'tie')).toBe(0.5)
  })

  test('the win rate counts ties as half', () => {
    expect(
      panelWinRate([
        { order: 'candidate-first', preference: 'A' },
        { order: 'baseline-first', preference: 'B' },
        { order: 'baseline-first', preference: 'tie' },
        { order: 'candidate-first', preference: 'B' },
      ]),
    ).toBe(0.625)
    expect(() => panelWinRate([])).toThrow('no judgments')
  })
})

describe('panel run state', () => {
  test('a finished run has every judgment and nothing pending', () => {
    const run = fold(
      new PanelLogBuilder()
        .started()
        .judge(1, 's_1', 'candidate-first', 'A')
        .judge(2, 's_2', 'baseline-first', 'tie')
        .judge(3, 's_3', 'baseline-first', 'A'),
    )
    expect(pendingJudges(run)).toEqual([])
    expect(awaitingReclaim(run)).toEqual([])
    expect(completable(run)).toEqual([])
    expect(judgments(run).map((j) => [j.judge, j.order, j.preference])).toEqual([
      [1, 'candidate-first', 'A'],
      [2, 'baseline-first', 'tie'],
      [3, 'baseline-first', 'A'],
    ])
    expect(panelWinRate(judgments(run))).toBe(0.5)
  })

  test('a preference saved before a crash is completable, not pending', () => {
    const run = fold(
      new PanelLogBuilder()
        .started()
        .judge(1, 's_1', 'candidate-first', 'A')
        .judgeStarted(2, 's_2', 'baseline-first')
        .preferred(2, 's_2', 'B', 'B reads better')
        .judgeStarted(3, 's_3', 'candidate-first'),
    )
    expect(pendingJudges(run)).toEqual([3])
    expect(completable(run)).toEqual([
      {
        panel: 'panel-1',
        judge: 2,
        session: 's_2',
        order: 'baseline-first',
        preference: 'B',
        reason: 'B reads better',
      },
    ])
    expect(awaitingReclaim(run)).toEqual([
      { judge: 2, session: 's_2' },
      { judge: 3, session: 's_3' },
    ])
  })

  test('a reclaimed judge is pending again and the reclaim is not a failure', () => {
    const run = fold(
      new PanelLogBuilder()
        .started(panelStarted({ judges: 1 }))
        .judgeStarted(1, 's_1', 'candidate-first')
        .ended(1, 's_1', 'reclaimed')
        .judgeStarted(1, 's_2', 'baseline-first')
        .ended(1, 's_2', 'interrupted'),
    )
    expect(pendingJudges(run)).toEqual([1])
    expect(awaitingReclaim(run)).toEqual([])
    expect(countedFailures(run, 1)).toEqual([])
  })

  test('no-terminal, failed and expired count toward the attempts', () => {
    const run = fold(
      new PanelLogBuilder()
        .started(panelStarted({ judges: 2 }))
        .judgeStarted(1, 's_1', 'candidate-first')
        .ended(1, 's_1', 'no-terminal')
        .judgeStarted(1, 's_2', 'candidate-first')
        .ended(1, 's_2', 'failed')
        .judgeStarted(2, 's_3', 'candidate-first')
        .ended(2, 's_3', 'expired'),
    )
    expect(countedFailures(run, 1)).toEqual(['no-terminal', 'failed'])
    expect(countedFailures(run, 1).length).toBe(PANEL_JUDGE_ATTEMPTS)
    expect(countedFailures(run, 2)).toEqual(['expired'])
  })

  test('a stale panel id is ignored and a new run replaces the latest', () => {
    const log = new PanelLogBuilder()
      .started()
      .judgeStarted(1, 's_1', 'candidate-first')
      .judgeStarted(1, 's_x', 'baseline-first', 'panel-0')
      .preferred(1, 's_x', 'A', 'stale', 'panel-0')
    const run = fold(log)
    expect(run.started.panel).toBe('panel-1')
    expect(run.judges['1']?.starts).toEqual([{ session: 's_1', order: 'candidate-first' }])
    expect(run.judges['1']?.preferred).toBeUndefined()

    log.started(panelStarted({ panel: 'panel-2', judges: 1 }))
    const next = fold(log)
    expect(next.started.panel).toBe('panel-2')
    expect(next.judges).toEqual({})
  })

  test('the build reducer embeds the latest run', () => {
    const log = new PanelLogBuilder().started().judge(1, 's_1', 'candidate-first', 'A')
    const state = reduceBuild(log.events)
    expect(state.panel?.started.panel).toBe('panel-1')
    expect(state.panel?.judges['1']?.judged?.preference).toBe('A')
  })
})
