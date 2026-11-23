import { useEffect, useState } from 'react'
import type { WebFrame } from '../../../core/src/web/protocol'

/** The server's model, pushed over one event stream. EventSource reconnects
 * on its own; the server sends the current frame to every new connection. */
export function useWebFrame(): WebFrame | undefined {
  const [frame, setFrame] = useState<WebFrame | undefined>(undefined)
  useEffect(() => {
    const source = new EventSource('/events')
    source.addEventListener('model', (event) => {
      try {
        setFrame(JSON.parse((event as MessageEvent<string>).data) as WebFrame)
      } catch {
        // A malformed frame is ignored; the next one replaces it.
      }
    })
    return () => source.close()
  }, [])
  return frame
}
