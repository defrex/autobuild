import { createMotion } from './motion'

export const DURATION = 6000
const BEATS = ['a-land', 'restack', 'b-land', 'complete', 'verify', 'consent'] as const

export function stateAt(timeMs: number): string | null {
  if (timeMs >= DURATION) return null
  return BEATS[Math.floor(Math.max(0, timeMs) / 1000)]!
}

/** Attribute-only rendering leaves all text, accessible descriptions and geometry intact. */
export function integrationRenderer(root: ParentNode): (time: number) => void {
  const elements = [...root.querySelectorAll<HTMLElement>('[data-integration-beats]')]
  return (time) => {
    const state = stateAt(time)
    for (const element of elements) {
      element.toggleAttribute(
        'data-integration-active',
        state !== null && element.dataset.integrationBeats!.split(' ').includes(state),
      )
    }
  }
}

export function bindIntegrationMotion(): void {
  const root = document.querySelector<HTMLElement>('[data-capture-figure="integration-tree"]')
  const control = root?.querySelector<HTMLButtonElement>('[data-motion-replay]')
  if (!root || !control) return
  const render = integrationRenderer(root)
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
  registry['integration-tree'] = fallback
  if (!window.IntersectionObserver || !window.requestAnimationFrame || !window.matchMedia) return
  try {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    registry['integration-tree'] = createMotion(DURATION, render, control, {
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
