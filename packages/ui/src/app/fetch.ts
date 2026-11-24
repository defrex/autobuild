import { useEffect, useRef, useState } from 'react'

/** One explicit read: its URL and the change position it was asked at. */
export interface ApiRequest {
  url: string
  key: string | undefined
}

/**
 * Whether `target` needs a fetch, given the last completed request and the
 * one in flight: `now` (aborting any request in flight), `after` (once the
 * request in flight completes, coalescing every trigger meanwhile into one
 * follow-up) or `no`. A new URL always fetches. The same URL fetches again
 * only for a defined key that differs from the request's it would repeat; an
 * absent key (a frame without a position) triggers nothing.
 */
export function shouldRefetch(
  target: ApiRequest,
  last: ApiRequest | undefined,
  inFlight: ApiRequest | undefined,
): 'now' | 'after' | 'no' {
  const moved = (from: ApiRequest) => target.key !== undefined && target.key !== from.key
  if (inFlight !== undefined) {
    if (inFlight.url !== target.url) return 'now'
    return moved(inFlight) ? 'after' : 'no'
  }
  if (last === undefined || last.url !== target.url) return 'now'
  return moved(last) ? 'now' : 'no'
}

export interface ApiState<T> {
  /** The last answer, kept while a newer request loads. */
  data: T | undefined
  /** The URL `data` answers. */
  dataUrl: string | undefined
  error: string | undefined
  loading: boolean
}

/**
 * Fetch `url` as JSON, again whenever it changes and whenever `refreshKey`
 * (the frame's change position) moves past the key of the last request. It
 * never polls: only a new URL or a new position fetches. An absent URL
 * fetches nothing.
 */
export function useApi<T>(url: string | undefined, refreshKey: string | undefined): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({
    data: undefined,
    dataUrl: undefined,
    error: undefined,
    loading: true,
  })
  const last = useRef<ApiRequest | undefined>(undefined)
  const inFlight = useRef<{ request: ApiRequest; controller: AbortController } | undefined>(
    undefined,
  )
  const latest = useRef<ApiRequest | undefined>(undefined)
  latest.current = url === undefined ? undefined : { url, key: refreshKey }

  const run = useRef((request: ApiRequest) => {
    const controller = new AbortController()
    inFlight.current = { request, controller }
    setState((s) => ({ ...s, loading: true }))
    const settle = (next: (s: ApiState<T>) => ApiState<T>) => {
      if (inFlight.current?.controller !== controller) return
      inFlight.current = undefined
      last.current = request
      setState(next)
      const target = latest.current
      if (target !== undefined && shouldRefetch(target, last.current, undefined) === 'now')
        run.current(target)
    }
    fetch(request.url, { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(async (response) => {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: unknown }
          | undefined
        if (!response.ok)
          throw new Error(
            typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`,
          )
        return body as T
      })
      .then(
        (data) => settle(() => ({ data, dataUrl: request.url, error: undefined, loading: false })),
        (error: unknown) => {
          if (controller.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          settle((s) => ({ ...s, error: message, loading: false }))
        },
      )
  })

  useEffect(() => {
    if (url === undefined) return
    const request = { url, key: refreshKey }
    if (shouldRefetch(request, last.current, inFlight.current?.request) !== 'now') return
    inFlight.current?.controller.abort()
    run.current(request)
  }, [url, refreshKey])

  useEffect(
    () => () => {
      inFlight.current?.controller.abort()
      inFlight.current = undefined
    },
    [],
  )
  return state
}
