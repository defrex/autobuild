import { createMotion } from './motion'

export const DURATION = 4800
const BEATS = [
  ['spec', ''],
  ['plan', 'plan'],
  ['plan-review', 'plan-review'],
  ['plan', 'plan-return'],
  ['plan-review', 'plan-review'],
  ['implement', 'implement'],
  ['code-review', 'code-review'],
  ['implement', 'code-return'],
  ['code-review', 'code-review'],
  ['verify:*', 'verify:*'],
  ['finalize', 'finalize'],
  ['merged', 'merged'],
] as const

export function stateAt(timeMs: number): { node: string; edge: string } | null {
  if (timeMs >= DURATION) return null
  const [node, edge] = BEATS[Math.floor(Math.max(0, timeMs) / 400)]!
  return { node, edge }
}

/** Attribute-only rendering leaves all text, accessible descriptions and geometry intact. */
export function pipelineRenderer(root: ParentNode): (time: number) => void {
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-motion-node]')]
  const edges = [...root.querySelectorAll<SVGElement>('[data-motion-edge]')]
  return (time) => {
    const state = stateAt(time)
    for (const node of nodes) {
      node.toggleAttribute('data-motion-active', node.dataset.motionNode === state?.node)
    }
    for (const edge of edges) {
      if (!state) edge.removeAttribute('data-motion-traversed')
      else
        edge.setAttribute('data-motion-traversed', String(edge.dataset.motionEdge === state.edge))
    }
  }
}

export function bindPipelineMotion(): void {
  const root = document.querySelector<HTMLElement>('[data-capture-figure="pipeline"]')
  const control = root?.querySelector<HTMLButtonElement>('[data-motion-replay]')
  if (!root || !control) return
  const render = pipelineRenderer(root)
  const fallback = {
    duration: DURATION,
    seek(timeMs: number, { still }: { still: boolean }) {
      render(DURATION)
      return { timeMs, still, complete: timeMs >= DURATION }
    },
  }
  // Register synchronously even when progressive enhancement is unavailable.
  window.__websiteCapture ??= {}
  const registry = window.__websiteCapture
  registry.pipeline = fallback
  if (!window.IntersectionObserver || !window.requestAnimationFrame || !window.matchMedia) return
  try {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    registry.pipeline = createMotion(DURATION, render, control, {
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
      reduced: () => media.matches,
      hidden: () => document.hidden,
      observe(enter) {
        const observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.15))
              enter()
          },
          { threshold: 0.15 },
        )
        observer.observe(root)
        return () => observer.disconnect()
      },
      onReducedChange(callback) {
        media.addEventListener('change', callback)
        return () => media.removeEventListener('change', callback)
      },
      onVisibilityChange(callback) {
        document.addEventListener('visibilitychange', callback)
        return () => document.removeEventListener('visibilitychange', callback)
      },
    })
  } catch {
    render(DURATION)
    control.hidden = true
  }
}
