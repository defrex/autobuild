import { expect, test } from 'bun:test'
import { stepOrder } from '../packages/core/src/kernel/step-durations'
import { orderSteps } from '../packages/ui/src/charts/step-durations'

// The web step table restates the served rollup's order as literals, because
// the browser bundle imports core only as types; this holds the two equal.
test('the web step table orders steps exactly as the served rollup does', () => {
  const steps = [
    'awaiting-merge',
    'queued',
    'verify:unit',
    'zeta',
    'reconcile',
    'plan',
    'escalated',
    'finalize',
    'verify:build',
    'code-review',
    'ticket-wait',
    'implement',
    'paused',
    'plan-review',
  ]
  const stat = (step: string) => ({
    step,
    category: 'plan' as const,
    count: 1,
    mean: 0,
    p50: 0,
    p90: 0,
    p99: 0,
    total: 0,
  })
  expect(orderSteps(steps.map(stat)).map((s) => s.step)).toEqual(stepOrder(steps))
})
