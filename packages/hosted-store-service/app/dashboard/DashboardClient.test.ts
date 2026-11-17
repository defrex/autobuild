import { expect, test } from 'bun:test'
import type { DashboardBuild } from '@defrex/autobuild/operator-presentation'
import {
  answerModeKeyAction,
  isNativeKeyboardActivation,
  retainAnswerStep,
} from './DashboardClient'
import { buildLink, projectLink, selectedProject } from './project-selection'

test('native control activation is excluded from dashboard-wide keyboard shortcuts', () => {
  const button = {
    closest: (selector: string) => (selector.includes('button') ? button : null),
  }
  const link = {
    closest: (selector: string) => (selector.includes('a[href]') ? link : null),
  }
  const rowTarget = { closest: () => null }

  expect(isNativeKeyboardActivation('Enter', button)).toBe(true)
  expect(isNativeKeyboardActivation(' ', button)).toBe(true)
  expect(isNativeKeyboardActivation('Enter', link)).toBe(true)
  expect(isNativeKeyboardActivation(' ', link)).toBe(false)
  expect(isNativeKeyboardActivation('Enter', rowTarget)).toBe(false)
  expect(isNativeKeyboardActivation('Escape', button)).toBe(false)
  expect(isNativeKeyboardActivation('Enter', null)).toBe(false)
})

test('answer mode consumes row shortcuts and permits only cancel or non-editor submit', () => {
  expect(answerModeKeyAction('Escape', true)).toBe('cancel')
  expect(answerModeKeyAction('Enter', false)).toBe('submit')
  expect(answerModeKeyAction('Enter', true)).toBe('pass')
  for (const key of ['a', 'r', 'p', 'm', 'd', 'i', 'h']) {
    expect(answerModeKeyAction(key, false), key).toBe('consume')
  }
  expect(answerModeKeyAction('r', true)).toBe('pass')
  expect(answerModeKeyAction('a', true)).toBe('pass')
  expect(answerModeKeyAction('Tab', false)).toBe('pass')
})

const first = 'https://github.com/acme/one'
const second = 'https://github.com/acme/two'
test('deep links and reload select the named registered project', () => {
  const link = projectLink(second, 'filter=blocked')
  const url = new URL(link, 'https://operator.example')
  expect(url.searchParams.get('filter')).toBe('blocked')
  expect(selectedProject([first, second], url.searchParams.get('repo')!)).toBe(second)
  expect(projectLink(first, url.search)).toContain('filter=blocked')
})
test('missing, invalid and removed selections fall back; empty registry has no selection', () => {
  expect(selectedProject([first, second], undefined)).toBe(first)
  expect(selectedProject([first], second)).toBe(first)
  expect(selectedProject([first], 'invalid')).toBe(first)
  expect(selectedProject([], second)).toBe('')
  expect(projectLink('', 'repo=removed&filter=blocked')).toBe('/?filter=blocked')
})
test('build pages live under /build with the project in the query', () => {
  expect(buildLink(second, 'fix login')).toBe(
    `/build/fix%20login?repo=${encodeURIComponent(second)}`,
  )
  expect(buildLink(first, 'demo', 'repo=stale&filter=blocked')).toBe(
    `/build/demo?repo=${encodeURIComponent(first)}&filter=blocked`,
  )
  expect(buildLink('', 'demo')).toBe('/build/demo')
})

test('an answer step survives refreshes while its build still offers an answer', () => {
  const row = (patch: Partial<DashboardBuild>): DashboardBuild => ({
    slug: 'waits',
    status: 'running',
    alsoPaused: false,
    steps: [],
    blockers: [],
    autoMerge: 'off',
    ...patch,
  })
  const wait = {
    tickets: ['B'],
    reason: 'needs B',
    since: '2026-11-16T00:00:00.000Z',
    escalation: 'esc_w',
    question: 'Waiting on B to complete: needs B.',
    text: 'waiting on B — needs B',
  }
  const step = { slug: 'waits', escalationIds: ['esc_w'], input: 'typed so far' }
  // A waiting row has no blockers; its open wait keeps the typed answer.
  expect(retainAnswerStep(step, { builds: [row({ status: 'waiting', wait })] })).toBe(step)
  // The wait ended or was answered elsewhere.
  expect(retainAnswerStep(step, { builds: [row({})] })).toBeUndefined()
  expect(retainAnswerStep(step, { builds: [] })).toBeUndefined()
  // Blocked rows keep the step exactly while blockers remain.
  expect(
    retainAnswerStep(step, { builds: [row({ status: 'blocked', blockers: ['question'] })] }),
  ).toBe(step)
  expect(retainAnswerStep(step, { builds: [row({ status: 'blocked' })] })).toBeUndefined()
})
