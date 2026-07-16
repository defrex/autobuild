/**
 * `ab artifact put|get` tests (SPEC §8.2): revisioned deposits (0-based,
 * §6.3), latest-vs-@rev fetches, and feedback-quality errors.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryBuildStore } from '../store/memory'
import { textContent } from '../store/types'
import { artifactGet, artifactPut, parseArtifactSpec } from './artifact'
import { makeEnv, seedStore } from './testkit'

let tmp: string
let store: MemoryBuildStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-artifact-'))
  store = await seedStore()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
  await store.close()
})

function deps() {
  return { store, env: makeEnv({ phase: 'plan', round: 1 }) }
}

describe('parseArtifactSpec', () => {
  test('parses bare kinds, @rev suffixes, and kinds containing colons', () => {
    expect(parseArtifactSpec('plan')).toEqual({ kind: 'plan' })
    expect(parseArtifactSpec('plan@2')).toEqual({ kind: 'plan', rev: 2 })
    expect(parseArtifactSpec('verify-report:e2e@0')).toEqual({
      kind: 'verify-report:e2e',
      rev: 0,
    })
  })

  test('rejects malformed refs with the expected format', () => {
    expect(() => parseArtifactSpec('plan@latest')).toThrow(/'<kind>@<rev>'/)
    expect(() => parseArtifactSpec('@2')).toThrow(/invalid artifact ref/)
  })
})

describe('artifact put/get', () => {
  test('put assigns 0-based revisions per kind (§6.3) and get round-trips', async () => {
    const v1 = join(tmp, 'plan-v1.md')
    const v2 = join(tmp, 'plan-v2.md')
    await writeFile(v1, '# Plan v1\n')
    await writeFile(v2, '# Plan v2\n')

    const first = await artifactPut(deps(), 'plan', v1)
    const second = await artifactPut(deps(), 'plan', v2)
    expect(first.revision).toBe(0)
    expect(second.revision).toBe(1)

    const latest = await artifactGet(deps(), 'plan')
    expect(textContent(latest)).toBe('# Plan v2\n')
    expect(latest.meta.revision).toBe(1)

    const pinned = await artifactGet(deps(), 'plan@0')
    expect(textContent(pinned)).toBe('# Plan v1\n')
  })

  test('put with a missing file names the path', async () => {
    await expect(artifactPut(deps(), 'plan', join(tmp, 'nope.md'))).rejects.toThrow(
      /file not found: .*nope\.md/,
    )
  })

  test('put with an empty kind is rejected', async () => {
    const file = join(tmp, 'x.md')
    await writeFile(file, 'x\n')
    await expect(artifactPut(deps(), '  ', file)).rejects.toThrow(/non-empty <kind>/)
  })

  test("put of kind 'spec' is rejected: the spec is immutable during a build (§6.3)", async () => {
    // Without this gate any phase's agent could deposit spec rev 1 with no
    // sanctioning spec.* event, silently swapping the contract every later
    // reviewer approves conformance to.
    const file = join(tmp, 'rewritten-spec.md')
    await writeFile(file, '# A different spec\n')
    await expect(artifactPut(deps(), 'spec', file)).rejects.toThrow(
      /'ab artifact put spec' is rejected.*immutable.*§6\.3.*ab escalate/s,
    )
    // Nothing was deposited: the seeded rev 0 is still the latest.
    const spec = await artifactGet(deps(), 'spec')
    expect(spec.meta.revision).toBe(0)
  })

  test('get of an absent kind lists the deposited kinds (D6 feedback)', async () => {
    await expect(artifactGet(deps(), 'plan')).rejects.toThrow(
      /no "plan" artifact in build "auth-rate-limit" — deposited kinds: spec/,
    )
  })

  test('get of an absent rev names the rev', async () => {
    await expect(artifactGet(deps(), 'spec@7')).rejects.toThrow(
      /no "spec" artifact at rev 7/,
    )
  })
})
