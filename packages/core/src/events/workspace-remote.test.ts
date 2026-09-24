import { describe, expect, test } from 'bun:test'
import { isRemoteWorkspace } from './workspace-remote'

describe('isRemoteWorkspace', () => {
  test('the marker decides when present, including marker-false over a legacy-suggestive name', () => {
    expect(isRemoteWorkspace({ provider: 'vercel-sandbox', remote: true })).toBe(true)
    expect(isRemoteWorkspace({ provider: 'git-worktree', remote: true })).toBe(true)
    expect(isRemoteWorkspace({ provider: 'vercel-sandbox', remote: false })).toBe(false)
    expect(isRemoteWorkspace({ provider: 'git-worktree', remote: false })).toBe(false)
  })

  test('an absent marker reads as local (marker-only semantics, AUT-505)', () => {
    expect(isRemoteWorkspace({ provider: 'vercel-sandbox' })).toBe(false)
    expect(isRemoteWorkspace({ provider: 'git-worktree' })).toBe(false)
  })
})
