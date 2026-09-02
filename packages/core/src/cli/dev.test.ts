import { expect, test } from 'bun:test'
import { evaluateDevCli, type DevCliState } from './dev'
import type { DashboardRenderer, DashboardRendererResolver } from './dashboard/render'

test('hot evaluations replace the renderer while retaining one CLI run and settlement path', async () => {
  const rendererA: DashboardRenderer = () => ['renderer A']
  const rendererB: DashboardRenderer = () => ['renderer B']
  const state: DevCliState = {}
  let finish!: (code: number) => void
  const pending = new Promise<number>((resolve) => {
    finish = resolve
  })
  let launches = 0
  let resolver: DashboardRendererResolver | undefined
  const settled: Promise<number>[] = []

  const evaluate = (renderer: DashboardRenderer): Promise<number> =>
    evaluateDevCli({
      state,
      renderer,
      launch: async (currentRenderer) => {
        launches += 1
        resolver = currentRenderer
        return pending
      },
      settle: (run) => settled.push(run),
    })

  const firstRun = evaluate(rendererA)
  // Launch is deliberately one microtask behind state installation.
  await Promise.resolve()
  expect(launches).toBe(1)
  expect(resolver?.()).toBe(rendererA)

  const secondRun = evaluate(rendererB)
  expect(secondRun).toBe(firstRun)
  expect(resolver?.()).toBe(rendererB)
  expect(launches).toBe(1)
  expect(settled).toEqual([firstRun])

  finish(17)
  expect(await secondRun).toBe(17)
})
