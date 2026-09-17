'use client'

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
}

/**
 * The system's one drop-down: a ghost-word trigger carrying the select's `▾`
 * glyph, and a list of ghost words in the reverse-video well beneath it. It is
 * opaque, square, and one row per item; there is no other layered surface.
 * Escape, an outside pointer, or choosing an item closes it and focus returns
 * to the trigger.
 */
export function Menu({
  label,
  items,
  className,
}: {
  label: ReactNode
  items: readonly MenuItem[]
  /** Extra class on the wrapper so a placement can pin or shrink it. */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [open])

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      buttons[(index + step + buttons.length) % buttons.length]?.focus()
    }
  }

  return (
    <span ref={rootRef} className={`menu${className ? ` ${className}` : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="word menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="menu-label">{label}</span>
        <span className="menu-glyph" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div ref={listRef} className="menu-list" role="menu" id={listId} onKeyDown={onListKey}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="word menu-item"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              <span className="menu-label">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
