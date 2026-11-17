/** Fallback landing routes summarize with the shared status wording. */
import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import { BUILD_ATTENTION_EVENTS, summarizeEvent } from './watch'

const route = { candidate: { head: 'aaa', parent: 'base', cycle: '1' }, decisionSeq: 3 }
const fact = (type: AbEvent['type'], payload: unknown) =>
  ({
    build: 'landing-build',
    seq: 9,
    ts: '2026-11-17T00:00:00.000Z',
    actor: DISPATCHER,
    type,
    payload,
  }) as AbEvent
const withPr = {
  ...reduceBuild([]),
  pr: { number: 12, url: 'https://example.com/pr/12', headSha: 'aaa' },
}

test('polling is not default attention; awaiting a human merge surfaces as merge attention', () => {
  // The actionable state reaches default watches through build.merge-decision.
  expect(BUILD_ATTENTION_EVENTS).not.toContain('landing.polling-selected' as never)
  expect(BUILD_ATTENTION_EVENTS).not.toContain('landing.human-merge-required' as never)
})

test('both events summarize with the shared reason text', () => {
  expect(
    summarizeEvent(
      fact('landing.polling-selected', { ...route, detail: 'GitHub GraphQL is unavailable' }),
      withPr,
    ),
  ).toBe(
    'Landing by polling because GitHub GraphQL is unavailable — Autobuild merges PR #12 when ' +
      'GitHub reports it clear to merge; this needs a running dispatcher',
  )
  expect(
    summarizeEvent(
      fact('landing.human-merge-required', {
        ...route,
        cause: 'merge-refused',
        detail: 'Pull Request is not mergeable',
      }),
      null,
    ),
  ).toBe(
    'Awaiting a human merge — GitHub refused the merge: "Pull Request is not mergeable"; ' +
      'merge the PR on GitHub',
  )
})
