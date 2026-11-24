import type { WebFrame } from '../../../core/src/web/protocol'

/** The page's embedded frame, a layout hint the page renders masked as its
 * loading skeleton. Never shown as live data. Anything unparseable is no hint. */
export function parseFrameHint(content: string | null | undefined): WebFrame | undefined {
  if (content === null || content === undefined) return undefined
  try {
    const value: unknown = JSON.parse(content)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as WebFrame)
      : undefined
  } catch {
    return undefined
  }
}

export function readFrameHint(): WebFrame | undefined {
  /* Literal of FRAME_META in packages/core/src/web/protocol.ts; the bundle
     imports core protocol only as types. */
  return parseFrameHint(document.querySelector<HTMLMetaElement>('meta[name="ab-frame"]')?.content)
}
