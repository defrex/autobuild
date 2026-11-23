import { type ReactNode, useEffect, useRef, useState } from 'react'

/**
 * The Reserved Space rule as a primitive: the placeholder and the content
 * share one grid cell, so the box is sized before data arrives and nothing
 * below it moves when it does. The swap is a crossfade.
 */
export function Reserve({
  ready,
  placeholder,
  children,
  label = 'Loading',
}: {
  ready: boolean
  placeholder: ReactNode
  children: ReactNode
  label?: string
}) {
  return (
    <div data-ansi="reserve" data-ready={ready ? '' : undefined} aria-busy={!ready}>
      <div data-ansi="reserve-placeholder" aria-hidden="true" inert>
        {placeholder}
      </div>
      <div data-ansi="reserve-content" inert={!ready}>
        {ready ? children : null}
      </div>
      {!ready && (
        <span data-ansi="visually-hidden" role="status">
          {label}
        </span>
      )}
    </div>
  )
}

export type Presence = 'entering' | 'present' | 'exiting'

/** Keep a removed element mounted while its exit transition runs. */
export function usePresence(present: boolean, exitMs: number): Presence | null {
  const [state, setState] = useState<Presence | null>(present ? 'present' : null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    clearTimeout(timer.current)
    if (present) {
      setState((s) => (s === null || s === 'exiting' ? 'entering' : s))
      timer.current = setTimeout(() => setState('present'), 16)
    } else {
      setState((s) => (s === null ? null : 'exiting'))
      timer.current = setTimeout(() => setState(null), exitMs)
    }
    return () => clearTimeout(timer.current)
  }, [present, exitMs])
  return state
}

/** Run a document-level change, such as a theme switch, as a crossfade where
 * the browser supports view transitions, and instantly where it doesn't. */
export function withTransition(change: () => void) {
  const start = (document as Document & { startViewTransition?: (cb: () => void) => unknown })
    .startViewTransition
  if (start === undefined || matchMedia('(prefers-reduced-motion: reduce)').matches) change()
  else start.call(document, change)
}
