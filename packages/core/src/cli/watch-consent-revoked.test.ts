/** Protected merge consent revocation is default watch attention. */
import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import { BUILD_ATTENTION_EVENTS, summarizeEvent } from './watch'

const revoked = (preview: string[], total = preview.length) =>
  ({
    build: 'protected-build',
    seq: 9,
    ts: '2026-11-17T00:00:00.000Z',
    actor: KERNEL,
    type: 'landing.consent-revoked',
    payload: {
      commandSeq: 4,
      source: 'reconcile',
      rule: { index: 1, snapshot: { paths: ['autobuild.toml'], mode: 'consent' } },
      previousHead: 'aaa111',
      head: 'bbb222',
      consentedHead: 'aaa000',
      paths: { total, preview },
    },
  }) as AbEvent

test('consent revocation is in the default attention filter', () => {
  expect(BUILD_ATTENTION_EVENTS).toContain('landing.consent-revoked')
})

test('the line names the build, the matched files and both heads', () => {
  expect(summarizeEvent(revoked(['autobuild.toml']), null)).toBe(
    'Merge consent revoked for protected-build: reconcile edited files protected by merge[1] (autobuild.toml); head aaa111 → bbb222; re-review and run ab merge protected-build',
  )
  expect(summarizeEvent(revoked(['a\u001b.toml', 'b.toml'], 5), null)).toContain(
    '(a\\u{1b}.toml, b.toml, +3 more)',
  )
})
