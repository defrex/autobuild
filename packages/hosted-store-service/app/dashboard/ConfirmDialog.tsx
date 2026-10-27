'use client'

import { type ReactNode, useEffect, useId, useRef } from 'react'

/**
 * The second step of every destructive action: a modal the page cannot shift
 * under. Escape, Cancel or a press outside the panel dismisses it; nothing is
 * written until the confirm button is pressed.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  pending = false,
  disabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  pending?: boolean
  /** The decision cannot be taken yet, though it can still be dismissed. */
  disabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open) {
      // Server markup opens the dialog in place so static frames show it;
      // once scripts run it becomes a true modal.
      if (dialog.open && !dialog.matches(':modal')) dialog.close()
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) dialog.close()
  }, [open])

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop press mirrors Escape, which the dialog's cancel event handles
    <dialog
      ref={ref}
      className="confirm-dialog"
      open={open || undefined}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!pending) onCancel()
      }}
      onClick={(event) => {
        // The dialog element itself is only the target outside its panel.
        if (event.target === event.currentTarget && !pending) onCancel()
      }}
    >
      {open && (
        <div className="confirm-panel">
          <h2 id={titleId}>{title}</h2>
          <div className="confirm-body">{children}</div>
          <div className="controls confirm-actions">
            <button
              type="button"
              className="btn danger primary"
              disabled={pending || disabled}
              // biome-ignore lint/a11y/noAutofocus: the dialog opened to take this decision; Enter confirms as in the terminal
              autoFocus
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
            <button type="button" className="btn ghost" disabled={pending} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </dialog>
  )
}
