/**
 * Store-reference resolution tests (SPEC §7.2, §8.1): local paths open the
 * SQLite store; http(s) URLs go to the injected remote factory — or fail
 * with a clear "not wired" error when no factory was provided.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteBuildStore } from '../store/local/store'
import { MemoryBuildStore } from '../store/memory'
import type { BuildStore } from '../store/types'
import { resolveStore } from './store-ref'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveStore', () => {
  test('a filesystem path opens the local SQLite store at that root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-store-ref-'))
    dirs.push(dir)
    const store = resolveStore(dir)
    try {
      expect(store).toBeInstanceOf(SqliteBuildStore)
      expect(existsSync(join(dir, 'autobuild.sqlite'))).toBe(true)
    } finally {
      await store.close()
    }
  })

  test('an https URL without a wired factory fails with the not-wired error', () => {
    expect(() => resolveStore('https://store.example.com')).toThrow(
      /remote store support not wired.*https:\/\/store\.example\.com.*bin\/ab\.ts/s,
    )
  })

  test('an http(s) URL routes to the remote factory with url and token', () => {
    const calls: Array<{ url: string; token?: string }> = []
    const fake = new MemoryBuildStore()
    const remoteFactory = (url: string, token?: string): BuildStore => {
      calls.push({ url, ...(token !== undefined ? { token } : {}) })
      return fake
    }
    const store = resolveStore('https://store.example.com/api', {
      remoteFactory,
      token: 'tok_scoped',
    })
    expect(store).toBe(fake)
    expect(calls).toEqual([{ url: 'https://store.example.com/api', token: 'tok_scoped' }])
  })

  test('plain http also counts as remote; token passes through as undefined', () => {
    const calls: Array<{ url: string; token: string | undefined }> = []
    const fake = new MemoryBuildStore()
    resolveStore('http://localhost:8787', {
      remoteFactory: (url, token) => {
        calls.push({ url, token })
        return fake
      },
    })
    expect(calls).toEqual([{ url: 'http://localhost:8787', token: undefined }])
  })
})
