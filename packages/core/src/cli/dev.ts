import type { DashboardRenderer, DashboardRendererResolver } from './dashboard/render'

/** State retained on `globalThis` across Bun hot module evaluations. */
export interface DevCliState {
  renderer?: DashboardRenderer
  run?: Promise<number>
}

export interface EvaluateDevCliOpts {
  state: DevCliState
  renderer: DashboardRenderer
  launch: (resolveDashboardRenderer: DashboardRendererResolver) => Promise<number>
  /** Install the process exit/rejection path for a newly launched run. */
  settle: (run: Promise<number>) => void
}

/**
 * Apply one hot evaluation. Every evaluation publishes the newest renderer,
 * but only the first creates and settles a CLI run. The resolver closes over
 * persistent state—not the first renderer—so an existing DispatchLoop sees a
 * replacement on its next paint without reconstructing any controller state.
 */
export function evaluateDevCli({
  state,
  renderer,
  launch,
  settle,
}: EvaluateDevCliOpts): Promise<number> {
  state.renderer = renderer
  if (state.run !== undefined) return state.run

  const resolveDashboardRenderer = (): DashboardRenderer => {
    const current = state.renderer
    if (current === undefined) {
      throw new Error('dashboard dev renderer is unavailable')
    }
    return current
  }

  // Defer launch by one microtask so state.run is installed before user wiring
  // can execute. This keeps even a synchronous/re-entrant launch single-shot.
  const run = Promise.resolve().then(() => launch(resolveDashboardRenderer))
  state.run = run
  settle(run)
  return run
}
