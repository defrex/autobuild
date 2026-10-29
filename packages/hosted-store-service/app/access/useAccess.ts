'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessRequestError, request } from './api'
import { latestRequest, mutationGate } from './state'
export function useAccess<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T>()
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<string>()
  const [forbidden, setForbidden] = useState(false)
  const writing = useRef(false)
  const mounted = useRef(true)
  const gate = useRef(latestRequest())
  const mutate = useRef(mutationGate())
  const controller = useRef<AbortController | undefined>(undefined)
  const refresh = useCallback(async () => {
    const id = gate.current.start()
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setPending(true)
    try {
      const next = await load(abort.signal)
      if (gate.current.current(id)) {
        setData(next)
        setForbidden(false)
        return next
      }
    } catch (failure) {
      if (!gate.current.current(id)) return
      if (failure instanceof AccessRequestError && failure.status === 403) {
        setForbidden(true)
        setData(undefined)
      }
      throw failure
    } finally {
      if (gate.current.current(id)) setPending(false)
    }
  }, [load])
  const reload = useCallback(() => {
    setError(undefined)
    void refresh().catch((failure: Error) => setError(failure.message))
  }, [refresh])
  useEffect(() => {
    mounted.current = true
    setData(undefined)
    reload()
    return () => {
      mounted.current = false
      gate.current.invalidate()
      controller.current?.abort()
    }
  }, [reload])
  async function write(path: string, method: string, body: unknown) {
    if (writing.current) return false
    writing.current = true
    setPending(true)
    setError(undefined)
    const result = await mutate.current(
      async () => {
        try {
          return await request(path, method, body)
        } catch (failure) {
          if (failure instanceof AccessRequestError && failure.status === 403) {
            setForbidden(true)
            void refresh().catch(() => {})
          }
          throw failure
        }
      },
      async () => {
        await refresh()
      },
      (message) => {
        if (mounted.current) setError(message)
      },
    )
    writing.current = false
    if (mounted.current) setPending(false)
    return result && mounted.current
  }
  return { data, pending, error, forbidden, reload, write, refresh }
}
