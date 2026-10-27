import type { ApprovalAssignment, ApprovalView } from './Connection'

export const normalizedCode = (code: string) =>
  /^[a-f0-9]{10}$/i.test(code) ? code.toUpperCase() : ''

export interface LookupResult extends ApprovalAssignment {
  connection: ApprovalView
}

// Both initial code links and manual entry use this request lifecycle. Invalidating
// a lookup prevents a late response (including an auth redirect) replacing newer input.
export function createConnectionLookup({
  request,
  navigate,
  resolved,
  failed,
  checking,
}: {
  request: (input: string, init: RequestInit) => Promise<Response>
  navigate: (path: string) => void
  resolved: (result: LookupResult) => void
  failed: (message: string) => void
  checking: (value: boolean) => void
}) {
  let generation = 0
  let active: { code: string; promise: Promise<void> } | undefined
  const invalidate = () => {
    generation++
    active = undefined
  }
  return {
    invalidate,
    lookup(code: string) {
      const normalized = normalizedCode(code)
      if (!normalized) {
        invalidate()
        checking(false)
        failed('Enter the ten-character connection code.')
        return Promise.resolve()
      }
      if (active?.code === normalized) return active.promise
      const current = ++generation
      checking(true)
      const promise = (async () => {
        try {
          const response = await request('/connect/v1/browser/lookup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: normalized }),
          })
          if (current !== generation) return
          if (response.status === 401) {
            navigate(`/sign-in?returnTo=${encodeURIComponent(`/connect?code=${normalized}`)}`)
            return
          }
          const body = (await response.json()) as LookupResult & { error?: string }
          if (current !== generation) return
          if (!response.ok)
            throw new Error(body.error || 'Could not confirm the connection. Try again.')
          if (!body.connection)
            throw new Error('Unknown connection code. Check the code in your CLI.')
          resolved(body)
        } catch (error) {
          if (current === generation)
            failed(
              error instanceof Error ? error.message : 'Connection service unavailable. Try again.',
            )
        } finally {
          if (current === generation) {
            active = undefined
            checking(false)
          }
        }
      })()
      active = { code: normalized, promise }
      return promise
    },
  }
}
