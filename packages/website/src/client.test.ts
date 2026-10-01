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
    querySelector: () => null,
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
})
