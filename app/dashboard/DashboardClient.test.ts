import { expect, test } from 'bun:test'
import type { OperatorBuildControlRequest } from 'autobuild/operator-api'
import type { Selection } from './BuildsView'
import {
  answerModeKeyAction,
  createRowControlHandlers,
  isNativeKeyboardActivation,
} from './DashboardClient'

type Action = OperatorBuildControlRequest['action']

function harness(selection?: Selection, openAnswer?: { slug: string; input: string }) {
  const events: string[] = []
  const controls: Array<{ slug: string; action: Action }> = []
  const confirmations: Array<string | undefined> = []
  let detail = true
  let selected = selection
  let answer = openAnswer
  let answerPending = false
  let error: string | undefined
  const handlers = createRowControlHandlers({
    selection,
    setSelection: (next) => {
      selected = next
      events.push(
        `select:${next === undefined ? 'none' : next.kind === 'build' ? next.slug : 'harvest'}`,
      )
    },
    clearTranscript: () => events.push('clear-transcript'),
    clearAnswerStep: () => {
      answer = undefined
      events.push('clear-answer')
    },
    setConfirmingAbort: (slug) => {
      confirmations.push(slug)
      events.push(`confirm:${slug ?? 'clear'}`)
    },
    setDetailOpen: (next) => {
      detail = typeof next === 'function' ? next(detail) : next
      events.push(`detail:${detail}`)
    },
    isAnswerPending: () => answerPending,
    control: (slug, action) => {
      controls.push({ slug, action })
      events.push(`control:${slug}:${action}`)
      // The harness models the existing answer-required classification returned by blocked RESUME.
      if (action === 'resume') answer = { slug, input: '' }
    },
    harvest: (body) => events.push(`harvest:${body.run}`),
  })
  return {
    handlers,
    events,
    controls,
    confirmations,
    cancelAnswer: () => {
      answer = undefined
    },
    startAnswerSubmission: () => {
      answerPending = true
      error = undefined
    },
    settleAnswerFailure: (message: string) => {
      error = message
      answerPending = false
    },
    state: () => ({ detail, selected, answer }),
    answerRequestState: () => ({ pending: answerPending, error }),
  }
}

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

test('a same-row action preserves open detail and keeps a blocked resume answer on its slug', () => {
  const slug = 'blocked-build'
  const value = harness({ kind: 'build', slug })

  value.handlers.buildControl(slug, 'resume')

  expect(value.state()).toEqual({
    detail: true,
    selected: { kind: 'build', slug },
    answer: { slug, input: '' },
  })
  expect(value.events).not.toContain('detail:false')
  expect(value.events.indexOf(`select:${slug}`)).toBeLessThan(
    value.events.indexOf(`control:${slug}:resume`),
  )
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

test('cancel preserves selected detail and a later blocked resume reopens a fresh answer once', () => {
  const slug = 'blocked-build'
  const value = harness({ kind: 'build', slug }, { slug, input: 'unfinished guidance' })

  value.cancelAnswer()
  expect(value.state()).toEqual({
    detail: true,
    selected: { kind: 'build', slug },
    answer: undefined,
  })
  expect(value.controls).toEqual([])

  value.handlers.buildControl(slug, 'resume')
  expect(value.controls).toEqual([{ slug, action: 'resume' }])
  expect(value.state()).toEqual({
    detail: true,
    selected: { kind: 'build', slug },
    answer: { slug, input: '' },
  })
})

test('abort after answer cancel stages confirmation and dispatches only when confirmed', () => {
  const slug = 'blocked-build'
  const value = harness({ kind: 'build', slug }, { slug, input: 'draft' })

  value.cancelAnswer()
  value.handlers.requestAbort(slug)
  expect(value.state().answer).toBeUndefined()
  expect(value.confirmations.at(-1)).toBe(slug)
  expect(value.controls).toEqual([])

  value.handlers.buildControl(slug, 'abort')
  expect(value.controls).toEqual([{ slug, action: 'abort' }])
})

test('an action on a different hovered row abandons the answer and selects that target', () => {
  const value = harness(
    { kind: 'build', slug: 'committed-build' },
    { slug: 'committed-build', input: 'draft' },
  )

  value.handlers.buildControl('hovered-build', 'pause')

  expect(value.state().selected).toEqual({ kind: 'build', slug: 'hovered-build' })
  expect(value.state().detail).toBe(false)
  expect(value.state().answer).toBeUndefined()
  expect(value.controls).toEqual([{ slug: 'hovered-build', action: 'pause' }])
  expect(value.events.indexOf('select:hovered-build')).toBeLessThan(
    value.events.indexOf('control:hovered-build:pause'),
  )
})

test('requesting row abort selects and confirms locally without dispatching until confirm', () => {
  const value = harness({ kind: 'build', slug: 'other-build' })

  value.handlers.requestAbort('abort-target')

  expect(value.controls).toEqual([])
  expect(value.state().selected).toEqual({ kind: 'build', slug: 'abort-target' })
  expect(value.confirmations.at(-1)).toBe('abort-target')

  const confirmation = harness({ kind: 'build', slug: 'abort-target' })
  confirmation.handlers.buildControl('abort-target', 'abort')
  expect(confirmation.controls).toEqual([{ slug: 'abort-target', action: 'abort' }])
  expect(confirmation.state().detail).toBe(true)
})

test('title activation during an in-flight answer preserves its draft through failure', () => {
  const slug = 'blocked-build'
  const value = harness({ kind: 'build', slug }, { slug, input: 'guidance that must survive' })
  value.startAnswerSubmission()

  value.handlers.toggleDetail(slug)
  expect(value.state()).toEqual({
    detail: true,
    selected: { kind: 'build', slug },
    answer: { slug, input: 'guidance that must survive' },
  })
  expect(value.events).toEqual([])

  value.settleAnswerFailure('answer request failed')
  expect(value.state().answer).toEqual({ slug, input: 'guidance that must survive' })
  expect(value.answerRequestState()).toEqual({ pending: false, error: 'answer request failed' })
})

test('closing detail releases the selection, and toggling opens after switching targets', () => {
  const same = harness({ kind: 'build', slug: 'selected-build' })
  same.handlers.toggleDetail('selected-build')
  expect(same.state().detail).toBe(false)
  expect(same.state().selected).toBeUndefined()

  const different = harness({ kind: 'build', slug: 'other-build' })
  different.handlers.toggleDetail('detail-target')
  expect(different.state().detail).toBe(true)
  expect(different.state().selected).toEqual({ kind: 'build', slug: 'detail-target' })
})

test('auto-merge indicator commands select their target without toggling same-row detail', () => {
  const value = harness({ kind: 'build', slug: 'merge-target' })

  value.handlers.buildControl('merge-target', 'auto-merge-on')

  expect(value.state().selected).toEqual({ kind: 'build', slug: 'merge-target' })
  expect(value.state().detail).toBe(true)
  expect(value.controls).toEqual([{ slug: 'merge-target', action: 'auto-merge-on' }])
})

test('Harvest row actions select their run before dispatch', () => {
  const value = harness({ kind: 'build', slug: 'build' })

  value.handlers.runHarvest({ action: 'run', run: 'h-target' })

  expect(value.state().selected).toEqual({ kind: 'harvest' })
  expect(value.events.indexOf('select:harvest')).toBeLessThan(
    value.events.indexOf('harvest:h-target'),
  )
})
