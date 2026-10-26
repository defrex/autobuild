'use client'

import { THEMES } from '../theme'
import { useTheme } from '../ThemeProvider'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'

export interface MenuLink {
  label: string
  href: string
}
export interface MenuAction {
  label: string
  onSelect: () => void
}
export interface MenuGroup {
  label?: string
  items: readonly MenuLink[]
}

/**
 * The system's one drop-down: a ghost-word trigger carrying the select's `▾`
 * glyph, an outlined opaque panel, and browser-local theme choices.
 * The panel is square and uses the page ground.
 * Escape, an outside pointer, or choosing an item closes it and focus returns
 * to the trigger.
 */
export function Menu({
  label,
  groups,
  actions,
  className,
  initiallyOpen = false,
}: {
  label: ReactNode
  groups: readonly MenuGroup[]
  actions: readonly MenuAction[]
  /** Initial disclosure state also used by offline presentation fixtures. */
  initiallyOpen?: boolean
  /** Extra class on the wrapper for placement. */
  className?: string
}) {
  const { theme, choose } = useTheme()
  const { open, setOpen, close, rootRef, triggerRef, listRef, listId, onListKey, onTriggerKey } =
    useMenuDisclosure(initiallyOpen)

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
        onKeyDown={onTriggerKey}
      >
        <span className="menu-label">{label}</span>{' '}
        <span className="menu-glyph" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div ref={listRef} className="menu-list" role="menu" id={listId} onKeyDown={onListKey}>
          {groups.map((group, index) => (
            <fieldset
              key={group.label ?? 'Navigation'}
              className="menu-group"
              aria-label={group.label ?? 'Navigation'}
            >
              {index > 0 && <div className="rule" />}
              {group.label && <div className="menu-label-heading">{group.label}</div>}
              {group.items.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  role="menuitem"
                  className="word menu-item"
                  onClick={close}
                >
                  {item.label}
                </a>
              ))}
            </fieldset>
          ))}
          <div className="rule" />
          <div className="menu-label-heading">Theme</div>
          <fieldset className="theme-choices" aria-label="Theme">
            {THEMES.map((choice) => (
              <button
                key={choice}
                type="button"
                role="menuitemradio"
                aria-checked={theme === choice}
                className="word"
                onClick={() => choose(choice)}
              >
                {choice.charAt(0).toUpperCase() + choice.slice(1)}
              </button>
            ))}
          </fieldset>
          <div className="rule" />
          {actions.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="word menu-item"
              onClick={() => {
                close()
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/**
 * The disclosure behavior every drop-down shares: focus moves into the panel
 * on open (to a `data-autofocus` item when one is marked), arrows walk its items, and Escape, Tab, or an outside pointer
 * closes it with focus back on the trigger.
 */
export function useMenuDisclosure(initiallyOpen = false) {
  const [open, setOpen] = useState(initiallyOpen)
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
    if (!open) return
    const items = listRef.current
    ;(
      items?.querySelector<HTMLElement>('[data-autofocus]') ??
      items?.querySelector<HTMLElement>('[role^=menuitem]')
    )?.focus()
  }, [open])

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLElement>('[role^=menuitem]') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      buttons[(index + step + buttons.length) % buttons.length]?.focus()
    }
  }

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault()
      setOpen(true)
    }
  }

  return { open, setOpen, close, rootRef, triggerRef, listRef, listId, onListKey, onTriggerKey }
}
