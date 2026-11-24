import type { StepText } from '../../../core/src/cli/dashboard/row-text'
import type { WebBuildRow, WebFrame } from '../../../core/src/web/protocol'
import type { Route } from './routes'

const pending = (label: string): StepText => ({
  label,
  state: 'pending',
  mark: '[ ]',
  tone: 'pending',
})

const row = (slug: string): WebBuildRow => ({
  slug,
  ticketId: '#0000',
  title: 'Loading build',
  kind: 'work',
  status: { status: 'queued', word: 'QUEUED', tone: 'pending' },
  flags: [],
  steps: [pending('plan'), pending('implement'), pending('verify')],
  attention: [],
})

/**
 * The page's shape when no layout hint arrived (a first read hung past the
 * page's wait). It is only ever rendered masked, so its words are never seen:
 * the dispatcher strip, one attention line and one row per section. The live
 * frame then reshapes it under a layout transaction before anything shows.
 */
export function fallbackFrame(route: Route): WebFrame {
  const active = row(route.page === 'build' ? route.slug : 'loading-active')
  return {
    overview: {
      dispatcher: { mode: 'stopped', word: 'stopped', tone: 'alert' },
      header: {
        counts: [
          { label: 'triage', value: '0' },
          { label: 'queue', value: '0' },
          { label: 'active', value: '0/0' },
        ],
        gates: [
          { label: 'intake', word: 'ON', tone: 'ok' },
          { label: 'harvest', word: 'ON', tone: 'ok' },
        ],
      },
      attention: [{ kind: 'wait', tone: 'held', text: 'Loading what needs attention' }],
      active: [active],
      queued: [row('loading-queued')],
      finished: [
        {
          slug: 'loading-finished',
          kind: 'work',
          outcome: 'merged',
          word: 'MERGED',
          tone: 'ok',
          completedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  }
}
