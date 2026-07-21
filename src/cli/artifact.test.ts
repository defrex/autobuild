/**
 * `ab artifact put|get` tests (SPEC §8.2): revisioned deposits (0-based,
 * §6.3), latest-vs-@rev fetches, and feedback-quality errors.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnExec } from '../ports/workspace/git-worktree'
import type { MemoryBuildStore } from '../store/memory'
import { textContent } from '../store/types'
import {
  artifactDownload,
  artifactGet,
  artifactPut,
  parseArtifactSpec,
} from './artifact'
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

  test('put preserves arbitrary binary bytes instead of UTF-8 coercing them', async () => {
    const path = join(tmp, 'frame.png')
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 254, 1])
    await writeFile(path, bytes)

    const meta = await artifactPut(deps(), 'visual:screenshot', path)
    const artifact = await store.getArtifact(
      'auth-rate-limit',
      'visual:screenshot',
      meta.revision,
    )
    expect(artifact?.content).toEqual(bytes)
  })

  test('put --attach atomically records exact refs, actor, filename, media type, and bytes', async () => {
    const path = join(tmp, 'home.png')
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255])
    await writeFile(path, bytes)
    const attachedDeps = {
      store,
      env: makeEnv({
        phase: 'verify:visual-check',
        round: 1,
        session: 's_visual',
      }),
    }

    const meta = await artifactPut(attachedDeps, 'visual:home', path, {
      attach: true,
    })

    expect(meta.revision).toBe(0)
    expect(
      (await store.getArtifact('auth-rate-limit', 'visual:home', 0))?.content,
    ).toEqual(bytes)
    const event = (await store.getEvents('auth-rate-limit')).at(-1)
    expect(event).toMatchObject({
      actor: {
        kind: 'agent',
        role: 'verify:visual-check',
        session: 's_visual',
      },
      type: 'pr-attachment.designated',
      payload: {
        artifact: { kind: 'visual:home', rev: 0 },
        filename: 'home.png',
        mediaType: 'image/png',
      },
    })
  })

  test('put --attach normalizes text media parameters and rejects unsafe filenames before writing', async () => {
    const textPath = join(tmp, 'trace.txt')
    await writeFile(textPath, 'trace\n')
    await artifactPut(deps(), 'visual:trace', textPath, { attach: true })
    expect(
      (await store.getEvents('auth-rate-limit')).at(-1)?.payload,
    ).toMatchObject({
      filename: 'trace.txt',
      mediaType: 'text/plain',
    })

    const unsafe = join(tmp, 'bad\nname.png')
    await writeFile(unsafe, new Uint8Array([1]))
    const before = await store.listArtifacts('auth-rate-limit')
    await expect(
      artifactPut(deps(), 'visual:unsafe', unsafe, { attach: true }),
    ).rejects.toThrow(/attachment filename/)
    expect(await store.listArtifacts('auth-rate-limit')).toEqual(before)
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

describe('artifact download', () => {
  test('selects the explicit store, forwards the opaque token, pins revisions, closes, and writes exact bytes', async () => {
    let closeCount = 0
    store.close = async () => {
      closeCount += 1
    }
    const build = 'finished-build'
    await store.createBuild({ slug: build, repo: resolve(tmp) })
    const first = new Uint8Array([137, 80, 78, 71, 0, 255])
    const second = new Uint8Array([1, 2, 3])
    await store.putArtifact(build, {
      kind: 'visual:wide',
      content: first,
    })
    await store.putArtifact(build, {
      kind: 'visual:wide',
      content: second,
    })
    const opens: Array<{ ref: string; token?: string }> = []
    const output = join(tmp, 'downloads', 'wide.png')

    const result = await artifactDownload({
      targetRepo: tmp,
      env: {
        AB_STORE: 'https://ignored.invalid',
        AB_TOKEN: ' scoped-token ',
      },
      exec: spawnExec,
      build,
      spec: 'visual:wide@0',
      outputPath: output,
      storeRef: 'explicit-store',
      openStore: (ref, token) => {
        opens.push({ ref, ...(token !== undefined ? { token } : {}) })
        return store
      },
    })

    expect(opens).toEqual([
      { ref: resolve(tmp, 'explicit-store'), token: ' scoped-token ' },
    ])
    expect(result.artifact.meta.revision).toBe(0)
    expect(result.outputPath).toBe(output)
    expect(new Uint8Array(await readFile(output))).toEqual(first)

    const remoteOutput = join(tmp, 'downloads', 'latest.png')
    await artifactDownload({
      targetRepo: tmp,
      env: {
        AB_STORE: 'https://store.example.invalid/api',
        AB_TOKEN: 'remote-token',
      },
      exec: spawnExec,
      build,
      spec: 'visual:wide',
      outputPath: remoteOutput,
      openStore: (ref, token) => {
        opens.push({ ref, ...(token !== undefined ? { token } : {}) })
        return store
      },
    })
    expect(opens.at(-1)).toEqual({
      ref: 'https://store.example.invalid/api',
      token: 'remote-token',
    })
    expect(new Uint8Array(await readFile(remoteOutput))).toEqual(second)
    expect(closeCount).toBe(2)
  })

  test('rejects unknown builds, wrong-repository builds, and absent refs without creating output', async () => {
    let closeCount = 0
    store.close = async () => {
      closeCount += 1
    }
    const output = join(tmp, 'should-not-exist.bin')
    const common = {
      targetRepo: tmp,
      env: {},
      exec: spawnExec,
      outputPath: output,
      openStore: () => store,
    }
    await expect(
      artifactDownload({
        ...common,
        build: 'missing',
        spec: 'frame@0',
      }),
    ).rejects.toThrow('no build "missing"')

    await store.createBuild({ slug: 'other-repo', repo: '/somewhere/else' })
    await expect(
      artifactDownload({
        ...common,
        build: 'other-repo',
        spec: 'frame@0',
      }),
    ).rejects.toThrow('belongs to repository')

    await store.createBuild({ slug: 'no-frame', repo: resolve(tmp) })
    await store.putArtifact('no-frame', { kind: 'text', content: 'hello' })
    await expect(
      artifactDownload({
        ...common,
        build: 'no-frame',
        spec: 'frame@7',
      }),
    ).rejects.toThrow(/no "frame" artifact at rev 7.*available refs: text@0/s)
    expect(await Bun.file(output).exists()).toBe(false)
    expect(closeCount).toBe(3)
  })

  test('validates build and artifact arguments before opening a store', async () => {
    let opens = 0
    const common = {
      targetRepo: tmp,
      env: {},
      exec: spawnExec,
      outputPath: join(tmp, 'unused'),
      openStore: () => {
        opens += 1
        return store
      },
    }
    await expect(
      artifactDownload({ ...common, build: '  ', spec: 'frame' }),
    ).rejects.toThrow(/non-empty <build>/)
    await expect(
      artifactDownload({ ...common, build: 'build', spec: '  ' }),
    ).rejects.toThrow(/non-empty <kind>/)
    expect(opens).toBe(0)
  })
})
