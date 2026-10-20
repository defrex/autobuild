import { createMotion } from './motion'

export function bindFigureMotion(
  id: string,
  duration: number,
  renderer: (root: ParentNode) => (time: number) => void,
): void {
  const root = document.querySelector<HTMLElement>(`[data-capture-figure="${id}"]`)
  const control = root?.querySelector<HTMLButtonElement>('[data-motion-replay]')
  if (!root || !control) return
  const render = renderer(root)
  const fallback = {
    duration: duration,
    seek(timeMs: number, { still }: { still: boolean }) {
      render(duration)
      return { timeMs, still, complete: timeMs >= duration }
    },
  }
  // Register synchronously even when progressive enhancement is unavailable.
  window.__websiteCapture ??= {}
  const registry = window.__websiteCapture
  registry[id] = fallback
  if (!window.IntersectionObserver || !window.requestAnimationFrame || !window.matchMedia) return
  try {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    registry[id] = createMotion(duration, render, control, {
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
    render(duration)
    control.hidden = true
  }
}
