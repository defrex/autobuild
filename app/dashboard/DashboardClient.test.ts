import { expect, test } from 'bun:test'
import type { OperatorBuildControlRequest } from 'autobuild/operator-api'
import type { Selection } from './BuildsView'
import { createRowControlHandlers } from './DashboardClient'

type Action = OperatorBuildControlRequest['action']

function harness(selection?: Selection) {
  const events: string[] = []
  const controls: Array<{ slug: string; action: Action }> = []
  const confirmations: Array<string | undefined> = []
  let detail = true
  let selected = selection
  let answerSlug: string | undefined
  const handlers = createRowControlHandlers({
    selection,
    setSelection: (next) => {
      selected = next
      events.push(`select:${next.kind === 'build' ? next.slug : 'harvest'}`)
    },
    clearTranscript: () => events.push('clear-transcript'),
    clearAnswerStep: () => events.push('clear-answer'),
    setConfirmingAbort: (slug) => {
      confirmations.push(slug)
      events.push(`confirm:${slug ?? 'clear'}`)
    },
    setDetailOpen: (next) => {
      detail = typeof next === 'function' ? next(detail) : next
      events.push(`detail:${detail}`)
    },
    control: (slug, action) => {
      controls.push({ slug, action })
      events.push(`control:${slug}:${action}`)
      if (action === 'resume') answerSlug = slug
    },
    harvest: (body) => events.push(`harvest:${body.run}`),
  })
  return {
    handlers,
    events,
    controls,
    confirmations,
    state: () => ({ detail, selected, answerSlug }),
  }
}

test('a same-row action preserves open detail and keeps a blocked resume answer on its slug', () => {
  const slug = 'blocked-build'
  const value = harness({ kind: 'build', slug })

  value.handlers.buildControl(slug, 'resume')

  expect(value.state()).toEqual({
    detail: true,
    selected: { kind: 'build', slug },
    answerSlug: slug,
  })
  expect(value.events).not.toContain('detail:false')
  expect(value.events.indexOf(`select:${slug}`)).toBeLessThan(
    value.events.indexOf(`control:${slug}:resume`),
  )
})

test('an action on a different hovered row selects that target without toggling detail', () => {
  const value = harness({ kind: 'build', slug: 'committed-build' })

  value.handlers.buildControl('hovered-build', 'pause')

  expect(value.state().selected).toEqual({ kind: 'build', slug: 'hovered-build' })
  expect(value.state().detail).toBe(false)
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

test('DETAILS toggles only its named row and opens after switching targets', () => {
  const same = harness({ kind: 'build', slug: 'selected-build' })
  same.handlers.toggleDetail('selected-build')
  expect(same.state().detail).toBe(false)
  expect(same.state().selected).toEqual({ kind: 'build', slug: 'selected-build' })

  const different = harness({ kind: 'build', slug: 'other-build' })
  different.handlers.toggleDetail('detail-target')
  expect(different.state().detail).toBe(true)
  expect(different.state().selected).toEqual({ kind: 'build', slug: 'detail-target' })
})

test('Harvest row actions select their run before dispatch', () => {
  const value = harness({ kind: 'build', slug: 'build' })

  value.handlers.runHarvest({ action: 'run', run: 'h-target' })

  expect(value.state().selected).toEqual({ kind: 'harvest' })
  expect(value.events.indexOf('select:harvest')).toBeLessThan(
    value.events.indexOf('harvest:h-target'),
  )
})
