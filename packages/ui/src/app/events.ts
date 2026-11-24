import { useEffect, useState } from 'react'
import type { WebFrame } from '../../../core/src/web/protocol'

/** The server's model, pushed over one event stream. EventSource reconnects
 * on its own; the server sends the current frame to every new connection.
 * `seq` counts parsed frames, so a page can tell which frame it settled on. */
export function useWebFrame(): { frame: WebFrame | undefined; seq: number } {
  const [state, setState] = useState<{ frame: WebFrame | undefined; seq: number }>({
    frame: undefined,
    seq: 0,
  })
  useEffect(() => {
    const source = new EventSource('/events')
    source.addEventListener('model', (event) => {
      try {
        const frame = JSON.parse((event as MessageEvent<string>).data) as WebFrame
        setState((s) => ({ frame, seq: s.seq + 1 }))
      } catch {
        // A malformed frame is ignored; the next one replaces it.
      }
    })
    return () => source.close()
  }, [])
  return state
}
