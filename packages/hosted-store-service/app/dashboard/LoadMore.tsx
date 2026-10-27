'use client'

import { useEffect, useRef } from 'react'

/**
 * The foot of a paged list: scrolling near it loads the next page, and the
 * button does the same for keyboard and assistive users. The count says how
 * much of the list is on screen.
 */
export function LoadMore({
  shown,
  total,
  loading,
  onMore,
}: {
  shown: number
  total: number
  loading: boolean
  onMore: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const more = shown < total
  useEffect(() => {
    const element = ref.current
    if (!more || loading || !element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onMore()
      },
      { rootMargin: '0px 0px 480px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [more, loading, onMore])
  if (!more) return null
  return (
    <div ref={ref} className="load-more">
      <button type="button" className="word" disabled={loading} onClick={onMore}>
        {loading ? 'Loading more' : 'Show more'}
      </button>
      <span className="slack">
        {shown} of {total}
      </span>
    </div>
  )
}
