'use client'

import { useEffect, useId, useRef, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'refused'

/** Copy `text` to the clipboard; any refusal or a missing clipboard reads
 * as `refused`, so the control never implies a copy that did not happen. */
export async function copyToClipboard(
  clipboard: Pick<Clipboard, 'writeText'> | undefined,
  text: string,
): Promise<'copied' | 'refused'> {
  if (clipboard === undefined) return 'refused'
  try {
    await clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'refused'
  }
}

const LABELS: Record<CopyState, string> = { idle: 'COPY', copied: 'COPIED', refused: 'REFUSED' }
const ANNOUNCEMENTS: Record<CopyState, string> = {
  idle: '',
  copied: 'MCP URL copied.',
  refused: 'Copy was refused. The URL is selected; copy it manually.',
}

/** The project's MCP URL in a read-only well with a copy word button. The
 * well is selectable text rather than an input, so a long URL wraps at phone
 * width instead of truncating; a refused copy selects it for manual copy. */
export function McpConnector({
  url,
  initialState = 'idle',
}: {
  url: string
  initialState?: CopyState
}) {
  const [state, setState] = useState<CopyState>(initialState)
  // Only a press arms the revert, so a state rendered for capture holds.
  const [presses, setPresses] = useState(0)
  const field = useRef<HTMLDivElement>(null)
  const fieldId = useId()
  useEffect(() => {
    if (presses === 0 || state !== 'copied') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state, presses])
  return (
    <div className="mcp-connector">
      <div ref={field} id={fieldId} className="m mcp-url">
        {url}
      </div>
      <button
        type="button"
        className="btn copy-state"
        data-state={state}
        aria-label={state === 'idle' ? 'Copy MCP URL' : LABELS[state]}
        aria-describedby={fieldId}
        onClick={async () => {
          const result = await copyToClipboard(
            typeof navigator === 'undefined' ? undefined : navigator.clipboard,
            url,
          )
          setState(result)
          setPresses((count) => count + 1)
          if (result === 'refused' && field.current) {
            const selection = window.getSelection()
            const range = document.createRange()
            range.selectNodeContents(field.current)
            selection?.removeAllRanges()
            selection?.addRange(range)
          }
        }}
      >
        {(Object.keys(LABELS) as CopyState[]).map((key) => (
          <span key={key} aria-hidden="true" data-shown={key === state ? '' : undefined}>
            {LABELS[key]}
          </span>
        ))}
      </button>
      <span className="sr-only" aria-live="polite">
        {ANNOUNCEMENTS[state]}
      </span>
    </div>
  )
}
