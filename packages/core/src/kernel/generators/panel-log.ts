import { validateEventWrite, type AbEvent, type EventWrite } from '../../events/catalog'
import { KERNEL, agentActor } from '../../events/envelope'
import type { EventPayload } from '../../events/payloads'
import type { PanelOrder, PanelPreference } from '../panel'

export const PANEL_SHA = (char: string) => char.repeat(40)

/** A panel run's inputs, with every field set. */
export function panelStarted(
  overrides: Partial<EventPayload<'panel.started'>> = {},
): EventPayload<'panel.started'> {
  return {
    panel: 'panel-1',
    candidate: PANEL_SHA('c'),
    baseline: PANEL_SHA('b'),
    harnessPin: PANEL_SHA('a'),
    purpose: 'clearer onboarding prose',
    rubric: 'evals/rubric.md',
    harness: ['evals/**'],
    judges: 3,
    ...overrides,
  }
}

/** Builds a validated panel log one fact at a time, with ascending seq. */
export class PanelLogBuilder {
  readonly events: AbEvent[] = []

  constructor(
    readonly build = 'panel-host',
    private clock = Date.parse('2026-11-18T00:00:00Z'),
  ) {}

  push(write: EventWrite): this {
    const valid = validateEventWrite(write)
    this.clock += 1_000
    this.events.push({
      ...valid,
      build: this.build,
      seq: this.events.length + 1,
      ts: new Date(this.clock).toISOString(),
    } as AbEvent)
    return this
  }

  started(payload = panelStarted()): this {
    return this.push({ actor: KERNEL, type: 'panel.started', payload })
  }

  judgeStarted(
    judge: number,
    session: string,
    order: PanelOrder,
    panel = 'panel-1',
    target: Partial<
      Pick<EventPayload<'panel.judge-started'>, 'runner' | 'model' | 'stream' | 'substitution'>
    > = {},
  ): this {
    return this.push({
      actor: KERNEL,
      type: 'panel.judge-started',
      payload: { panel, judge, session, order, runner: 'scripted', ...target },
    })
  }

  /** An alternate judge session replacing `failed`, the chain entry at
   * `index`, after an alternate-eligible failure. */
  substituted(
    judge: number,
    session: string,
    order: PanelOrder,
    failed: { session: string; index: number; runner: string },
    target: { runner: string; stream?: string } = { runner: 'backup' },
  ): this {
    return this.judgeStarted(judge, session, order, 'panel-1', {
      ...target,
      substitution: {
        failed: { ...failed, error: 'provider overloaded', cause: 'availability' },
        selectedIndex: failed.index + 1,
      },
    })
  }

  preferred(
    judge: number,
    session: string,
    preference: PanelPreference,
    reason = `judge ${judge} reason`,
    panel = 'panel-1',
  ): this {
    return this.push({
      actor: agentActor('judge', session),
      type: 'panel.preferred',
      payload: { panel, judge, session, preference, reason },
    })
  }

  judged(
    judge: number,
    session: string,
    order: PanelOrder,
    preference: PanelPreference,
    reason = `judge ${judge} reason`,
    panel = 'panel-1',
  ): this {
    return this.push({
      actor: KERNEL,
      type: 'panel.judged',
      payload: { panel, judge, session, order, preference, reason },
    })
  }

  ended(
    judge: number,
    session: string,
    outcome: EventPayload<'panel.judge-ended'>['outcome'],
    panel = 'panel-1',
  ): this {
    return this.push({
      actor: KERNEL,
      type: 'panel.judge-ended',
      payload: { panel, judge, session, outcome },
    })
  }

  /** A judge's whole successful session. */
  judge(judge: number, session: string, order: PanelOrder, preference: PanelPreference): this {
    return this.judgeStarted(judge, session, order)
      .preferred(judge, session, preference)
      .judged(judge, session, order, preference)
      .ended(judge, session, 'completed')
  }
}
