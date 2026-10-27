import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { tabLink, ticketLink } from './project-selection'
import { bodyWithoutTitle, excerpt, tabForState, ticketMoves, ViewTabs } from './tickets'

const repo = 'https://github.com/example/happy'
const names = { triage: 'triage', ready: 'ready', done: 'done' }

test('tickets map to the tab of their lifecycle state; claimed tickets are active', () => {
  expect(tabForState('triage', names)).toBe('triage')
  expect(tabForState('ready', names)).toBe('queue')
  expect(tabForState('done', names)).toBe('done')
  expect(tabForState('doing', names)).toBe('active')
  expect(tabForState('ready', undefined)).toBeUndefined()
})

test('tab and ticket links carry the project; active is the home page', () => {
  expect(tabLink(repo, 'active')).toBe(`/?repo=${encodeURIComponent(repo)}`)
  expect(tabLink(repo, 'queue')).toBe(`/queue?repo=${encodeURIComponent(repo)}`)
  expect(ticketLink(repo, 'AUT-1')).toBe(`/ticket/AUT-1?repo=${encodeURIComponent(repo)}`)
})

test('the current tab claims the page only on its own list', () => {
  const list = renderToStaticMarkup(
    <ViewTabs repo={repo} current="queue" page counts={{ triage: 2, queue: 0 }} />,
  )
  expect(list).toContain('aria-current="page"')
  expect(list).toContain('Queue<span class="count">0</span>')
  expect(list).toContain('Done</a>')
  const detail = renderToStaticMarkup(
    <ViewTabs repo={repo} current="active" page={false} counts={{}} />,
  )
  expect(detail).toContain('aria-current="true"')
  expect(detail).not.toContain('aria-current="page"')
})

test('row excerpts take the first prose paragraph as plain text', () => {
  expect(excerpt('## Scope\n\nSplit the **adapters** into `files`.\n\n- a')).toBe(
    'Split the adapters into files.',
  )
  expect(excerpt('- only\n- a list')).toBe('')
})

test('a leading heading that repeats the title is dropped; any other heading stays', () => {
  expect(bodyWithoutTitle('# Abort a build\n\nBody.', 'Abort a build')).toBe('Body.')
  expect(bodyWithoutTitle('## Scope\n\nBody.', 'Abort a build')).toBe('## Scope\n\nBody.')
})

test('triage offers enqueue, and ice only where an icebox exists; the queue offers dequeue', () => {
  const labels = (state: string, counts?: Record<string, number>) =>
    ticketMoves(state, names, counts).map((move) => `${move.label}->${move.state}`)
  expect(labels('triage', { triage: 3, ready: 1, icebox: 0 })).toEqual([
    'ENQUEUE->ready',
    'ICE->icebox',
  ])
  expect(labels('triage', { triage: 3, ready: 1 })).toEqual(['ENQUEUE->ready'])
  expect(labels('ready')).toEqual(['DEQUEUE->triage'])
  expect(labels('done')).toEqual([])
  expect(labels('doing')).toEqual([])
})
