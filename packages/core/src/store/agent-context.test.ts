import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { gitBlobOid, matchesGitBlobOid } from '../ports/forge/git-blob'
import {
  AGENT_CONTEXT_CACHE_PART_OVERHEAD,
  decodeAgentContext,
  decodeAgentContextPointer,
  encodeAgentContext,
  packContinuation,
  unpackContinuation,
  type AgentContextRecord,
} from './agent-context'

const record = (commit: string): AgentContextRecord => ({
  version: 1,
  commit,
  baseBranch: 'main',
  skills: [
    {
      name: 'x',
      paths: ['.agents/skills/x'],
      files: [{ path: 'SKILL.md', oid: 'o1', bytes: 3, text: '# x' }],
    },
  ],
  instructions: [
    { paths: ['AGENTS.md'], directory: '', oid: 'o2', bytes: 1, base64: 'AA==', imports: [] },
  ],
  imports: [],
  links: [],
  omitted: [],
})

describe('record codec', () => {
  test('round-trips, and the digest identifies content regardless of commit', () => {
    const a = encodeAgentContext(record('a'.repeat(40)))
    expect(decodeAgentContext(a.content)).toEqual(record('a'.repeat(40)))
    expect(a.rawBytes).toBe(4)
    expect(encodeAgentContext(record('b'.repeat(40))).digest).toBe(a.digest)
  })

  test('malformed records and pointers are rejected', () => {
    const bad = { ...record('c'), version: 2 }
    expect(() => decodeAgentContext(new Uint8Array(gzipSync(JSON.stringify(bad))))).toThrow()
    expect(() =>
      decodeAgentContextPointer(new TextEncoder().encode('{"version":1,"branch":"main"}')),
    ).toThrow()
  })

  test('a record that inflates past the decode limit is refused', () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(8 * 1024 * 1024)))
    expect(bomb.byteLength).toBeLessThan(64 * 1024)
    expect(() => decodeAgentContext(bomb, 1024 * 1024)).toThrow('decodes beyond')
  })
})

describe('packContinuation', () => {
  const blob = (size: number, seed: number) => {
    const bytes = new Uint8Array(size).map((_, i) => (i * seed) % 256)
    return { oid: gitBlobOid(bytes), bytes }
  }
  const payload = 2 * AGENT_CONTEXT_CACHE_PART_OVERHEAD + 400

  test('full slots are kept, the last partial one is extended, and new slots are appended', () => {
    const first = packContinuation('c1', [], [blob(30, 3)], payload)
    expect(first.slots).toHaveLength(1)
    const next = packContinuation('c1', first.slots, [blob(30, 5), blob(600, 7)], payload)
    expect(next.rewritten[0]).toBe(0)
    expect(next.slots.length).toBeGreaterThan(2)
    const again = packContinuation('c1', next.slots, [blob(9, 11)], payload)
    expect(again.rewritten).toEqual([next.slots.length - 1])
    for (const slot of again.slots) {
      const cost = slot.parts.reduce(
        (total, part) => total + part.base64.length + AGENT_CONTEXT_CACHE_PART_OVERHEAD,
        0,
      )
      expect(cost).toBeLessThanOrEqual(payload)
    }
  })

  test('split blobs reassemble by offset; incomplete ones are dropped', () => {
    const large = blob(1500, 13)
    const small = blob(10, 17)
    const { slots } = packContinuation('c1', [], [large, small], payload)
    expect(slots.length).toBeGreaterThan(3)
    expect(
      slots.flatMap((slot) => slot.parts.filter((part) => part.oid === large.oid)),
    ).not.toHaveLength(1)
    const all = unpackContinuation(slots, matchesGitBlobOid)
    expect(all.get(large.oid)).toEqual(large.bytes)
    expect(all.get(small.oid)).toEqual(small.bytes)
    const partial = unpackContinuation(slots.slice(1), matchesGitBlobOid)
    expect(partial.has(large.oid)).toBe(false)
  })
})
