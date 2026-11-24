/* ?cls=1 sums layout shifts that no input caused and reports the total in
   the title, so the No Layout Shift rule is measured, not eyeballed. */
export function installClsProbe(): void {
  if (!new URLSearchParams(location.search).has('cls')) return
  let total = 0
  const sources: string[] = []
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & {
      value: number
      hadRecentInput: boolean
      sources?: { node?: Node | null }[]
    })[]) {
      if (entry.hadRecentInput) continue
      total += entry.value
      for (const src of entry.sources ?? []) {
        const el = src.node instanceof Element ? src.node : src.node?.parentElement
        if (el)
          sources.push(
            `${el.getAttribute('data-ansi') ?? el.getAttribute('data-catalog') ?? el.tagName}[${(el.textContent ?? '').slice(0, 18)}]@${Math.round((src as { previousRect?: DOMRectReadOnly }).previousRect?.y ?? 0)}->${Math.round((src as { currentRect?: DOMRectReadOnly }).currentRect?.y ?? 0)} h${Math.round((src as { previousRect?: DOMRectReadOnly }).previousRect?.height ?? 0)}->${Math.round((src as { currentRect?: DOMRectReadOnly }).currentRect?.height ?? 0)} x${Math.round((src as { previousRect?: DOMRectReadOnly }).previousRect?.x ?? 0)}->${Math.round((src as { currentRect?: DOMRectReadOnly }).currentRect?.x ?? 0)} @${Math.round(entry.startTime)}`,
          )
      }
    }
    document.title = `CLS ${total.toFixed(4)} ${[...new Set(sources)].slice(0, 8).join(',')}`
  }).observe({ type: 'layout-shift', buffered: true })
}
