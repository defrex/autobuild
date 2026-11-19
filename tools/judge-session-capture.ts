import { projectSessions } from '../packages/core/src/cli/dashboard/detail'
import { dashboardFactsReducer } from '../packages/core/src/cli/dashboard/facts'
import { KERNEL } from '../packages/core/src/events/envelope'
import { PanelLogBuilder, panelStarted } from '../packages/core/src/kernel/generators/panel-log'
import type { StreamRecord } from '../packages/core/src/store/types'

/**
 * A judge panel's sessions on the build detail: judge 1's primary failed and
 * its alternate preferred, judge 2 preferred on its primary, judge 3 is still
 * open. The rows come from the shipped facts reducer and session projection.
 */
export function judgeSessionCapture() {
  const log = new PanelLogBuilder('capture')
    .push({
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session: 's_implement',
        role: 'implement',
        runner: 'pi',
        phase: 'implement',
        round: 1,
      },
    })
    .push({
      actor: KERNEL,
      type: 'session.ended',
      payload: {
        session: 's_implement',
        transcript: { kind: 'transcript', rev: 0 },
        usage: { inputTokens: 1200, outputTokens: 300, turns: 4 },
      },
    })
    .started(panelStarted({ judges: 3 }))
    .judgeStarted(1, 's_judge_1a', 'candidate-first', 'panel-1', {
      runner: 'codex',
      stream: 'st_judge_1a',
    })
    .ended(1, 's_judge_1a', 'failed')
    .substituted(
      1,
      's_judge_1b',
      'candidate-first',
      { session: 's_judge_1a', index: 0, runner: 'codex' },
      { runner: 'claude', stream: 'st_judge_1b' },
    )
    .ended(1, 's_judge_1b', 'completed')
    .judgeStarted(2, 's_judge_2', 'baseline-first', 'panel-1', {
      runner: 'codex',
      stream: 'st_judge_2',
    })
    .ended(2, 's_judge_2', 'completed')
    .judgeStarted(3, 's_judge_3', 'candidate-first', 'panel-1', {
      runner: 'codex',
      stream: 'st_judge_3',
    })
  const facts = dashboardFactsReducer.reduce(log.events)
  const stream = (session: string, status: StreamRecord['status']): StreamRecord => ({
    id: `st_${session.slice(2)}`,
    scope: { kind: 'build', build: 'capture' },
    label: `session:${session}`,
    format: 'ai-ui-message-stream/v1',
    status,
    createdAt: '2026-11-18T00:00:00.000Z',
  })
  const streams = [
    stream('s_judge_1a', 'closed'),
    stream('s_judge_1b', 'closed'),
    stream('s_judge_2', 'closed'),
    stream('s_judge_3', 'open'),
  ]
  return projectSessions(facts.sessionEvents, streams, facts.judgeSessions)
}
