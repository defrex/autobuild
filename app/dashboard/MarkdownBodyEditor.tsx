'use client'

import type { OverType as OverTypeInstance, Theme } from 'overtype'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const dashboardTheme: Theme = {
  name: 'autobuild',
  colors: {
    bgPrimary: 'var(--well)',
    bgSecondary: 'var(--well)',
    text: 'var(--ink)',
    textPrimary: 'var(--ink)',
    textSecondary: 'var(--slack)',
    h1: 'var(--title)',
    h2: 'var(--title)',
    h3: 'var(--title)',
    strong: 'var(--ink)',
    em: 'var(--ink)',
    link: 'var(--live)',
    code: 'var(--ink)',
    codeBg: 'var(--ground)',
    blockquote: 'var(--slack)',
    hr: 'var(--rule)',
    listMarker: 'var(--slack)',
    syntax: 'var(--slack)',
    syntaxMarker: 'var(--slack)',
    cursor: 'var(--live)',
    selection: 'color-mix(in srgb, var(--live) 35%, transparent)',
  },
}

function focusOutsideEditor(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return
  event.preventDefault()
  event.stopPropagation()
  const focusable = [
    ...document.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.offsetParent !== null)
  const current = event.target as HTMLElement
  const index = focusable.indexOf(current)
  focusable[index + (event.shiftKey ? -1 : 1)]?.focus()
}

/**
 * One body region: semantic markdown on the server/static captures, enhanced
 * after hydration by OverType's source-preserving textarea/render overlay.
 */
export function MarkdownBodyEditor({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<OverTypeInstance | undefined>(undefined)
  const callback = useRef(onChange)
  const currentValue = useRef(value)
  const currentDisabled = useRef(disabled)
  const [enhanced, setEnhanced] = useState(false)
  callback.current = onChange
  currentValue.current = value
  currentDisabled.current = disabled

  useEffect(() => setEnhanced(true), [])

  useEffect(() => {
    if (!enhanced || !host.current) return
    let live = true
    void import('overtype').then(({ default: OverType }) => {
      if (!live || !host.current) return
      const [instance] = new OverType(host.current, {
        value: currentValue.current,
        toolbar: false,
        smartLists: false,
        showStats: false,
        spellcheck: false,
        autoResize: true,
        minHeight: 'calc(var(--row) * 14)',
        maxHeight: null,
        fontFamily: 'var(--font-mono)',
        fontSize: 'inherit',
        lineHeight: 'var(--row)',
        padding: '0 1ch',
        theme: dashboardTheme,
        textareaProps: { 'aria-label': 'Body', disabled: currentDisabled.current },
        onChange: (next) => callback.current(next),
      })
      if (instance) editor.current = instance
    })
    return () => {
      live = false
      editor.current?.destroy()
      editor.current = undefined
    }
  }, [enhanced])

  useEffect(() => {
    const instance = editor.current
    if (instance && instance.getValue() !== value) instance.setValue(value)
  }, [value])

  useEffect(() => {
    if (editor.current) editor.current.textarea.disabled = disabled
  }, [disabled])

  return (
    <section className="markdownBodyEditor" aria-label="Body" onKeyDownCapture={focusOutsideEditor}>
      <div ref={host} className="markdown markdownEditorHost">
        {!enhanced && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              img: ({ src, alt }) => {
                const href = typeof src === 'string' ? src : undefined
                return <a href={href}>{`![${alt ?? ''}](${href ?? ''})`}</a>
              },
            }}
          >
            {value}
          </ReactMarkdown>
        )}
      </div>
    </section>
  )
}
