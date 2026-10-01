import { describe, expect, test } from 'bun:test'
import { applyState } from './client'
import { setAll, initialState } from './seams'

/** A minimal stand-in for the bound `.seam-selector` root: it matches the selector itself and has no descendants. */
function fakeSelectorRoot() {
  const attrs: Record<string, string> = { 'data-lean': 'local' }
  const root = {
    attrs,
    matches: (selector: string) => selector === '.seam-selector',
    setAttribute: (name: string, value: string) => {
      attrs[name] = value
    },
    knob: { style: { left: '' } },
    querySelector: (selector: string) => (selector === '.knob' ? root.knob : null),
    querySelectorAll: () => [],
  }
  return root
}

describe('applyState', () => {
  test('updates data-lean on the selector root itself, not only descendants', () => {
    const root = fakeSelectorRoot()
    applyState(root as unknown as ParentNode, setAll(initialState(), 'remote'))
    expect(root.attrs['data-lean']).toBe('remote')
    applyState(root as unknown as ParentNode, setAll(initialState(), 'local'))
    expect(root.attrs['data-lean']).toBe('local')
  })

  test('writes the knob position inline, which the stylesheet transition animates', () => {
    const root = fakeSelectorRoot()
    applyState(root as unknown as ParentNode, setAll(initialState(), 'remote'))
    expect(root.knob.style.left).toBe('calc(100% - 24px)')
  })
})
