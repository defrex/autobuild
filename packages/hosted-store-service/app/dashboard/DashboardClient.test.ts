import { expect, test } from 'bun:test'
import { answerModeKeyAction, isNativeKeyboardActivation } from './DashboardClient'
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
