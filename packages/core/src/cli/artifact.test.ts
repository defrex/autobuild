/**
 * `ab artifact put|get` tests (SPEC §8.2): revisioned deposits (0-based,
 * §6.3), latest-vs-@rev fetches, and feedback-quality errors.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnExec } from '../ports/workspace/git-worktree'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { PhaseSessionError } from '../store/phase-session'
import { textContent } from '../store/types'
import {
  artifactDownload,
  artifactDownloadStream,
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
    const artifact = await store.getArtifact('auth-rate-limit', 'visual:screenshot', meta.revision)
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
    expect((await store.getArtifact('auth-rate-limit', 'visual:home', 0))?.content).toEqual(bytes)
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
    expect((await store.getEvents('auth-rate-limit')).at(-1)?.payload).toMatchObject({
      filename: 'trace.txt',
      mediaType: 'text/plain',
    })

    const unsafe = join(tmp, 'bad\nname.png')
    await writeFile(unsafe, new Uint8Array([1]))
    const before = await store.listArtifacts('auth-rate-limit')
    await expect(artifactPut(deps(), 'visual:unsafe', unsafe, { attach: true })).rejects.toThrow(
      /attachment filename/,
    )
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
    await expect(artifactGet(deps(), 'spec@7')).rejects.toThrow(/no "spec" artifact at rev 7/)
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

    expect(opens).toEqual([{ ref: resolve(tmp, 'explicit-store'), token: ' scoped-token ' }])
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

  test('complete ambient identity permits own download and denies foreign or Harvest reads', async () => {
    const repo = resolve(tmp)
    await store.createBuild({ slug: 'ambient', repo })
    await store.createBuild({ slug: 'foreign', repo })
    const bytes = new Uint8Array([0, 1, 2, 255])
    await store.putArtifact('ambient', { kind: 'evidence', content: bytes })
    await store.putArtifact('foreign', { kind: 'evidence', content: bytes })
    const ownOutput = join(tmp, 'ambient.bin')
    const ambient = {
      AB_STORE: '/phase/store',
      AB_BUILD: 'ambient',
      AB_PHASE: 'implement@1',
      AB_SESSION: 's_phase',
    }

    await artifactDownload({
      targetRepo: tmp,
      env: ambient,
      exec: spawnExec,
      build: 'ambient',
      spec: 'evidence',
      outputPath: ownOutput,
      openStore: () => store,
    })
    expect(new Uint8Array(await readFile(ownOutput))).toEqual(bytes)

    const deniedOutput = join(tmp, 'denied.bin')
    await expect(
      artifactDownload({
        targetRepo: tmp,
        env: ambient,
        exec: spawnExec,
        build: 'foreign',
        spec: 'evidence',
        outputPath: deniedOutput,
        openStore: () => store,
      }),
    ).rejects.toBeInstanceOf(PhaseSessionError)
    expect(await Bun.file(deniedOutput).exists()).toBe(false)

    await store.ensureRepo(repo)
    await expect(
      artifactDownload({
        targetRepo: tmp,
        env: {
          AB_STORE: '/phase/store',
          AB_REPO: repo,
          AB_HARVEST: 'h_1',
          AB_PHASE: 'synthesize@1',
          AB_SESSION: 'hs_1',
        },
        exec: spawnExec,
        build: 'ambient',
        spec: 'evidence',
        outputPath: deniedOutput,
        openStore: () => store,
      }),
    ).rejects.toBeInstanceOf(PhaseSessionError)
    expect(await Bun.file(deniedOutput).exists()).toBe(false)
  })

  test('rejects malformed ambient identity before opening or creating output', async () => {
    let opens = 0
    const output = join(tmp, 'partial.bin')
    await expect(
      artifactDownload({
        targetRepo: tmp,
        env: { AB_PHASE: 'implement@1' },
        exec: spawnExec,
        build: 'ambient',
        spec: 'evidence',
        outputPath: output,
        openStore: () => {
          opens += 1
          return store
        },
      }),
    ).rejects.toThrow(/invalid ambient context/)
    expect(opens).toBe(0)
    expect(await Bun.file(output).exists()).toBe(false)
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

  test('accepts a differently located checkout of the same origin; foreign origins stay rejected', async () => {
    const exec: Exec = async (cmd) =>
      cmd[1] === 'remote'
        ? { stdout: 'git@github.com:acme/app.git\n', stderr: '', exitCode: 0 }
        : {
            stdout: '/guest/checkout/.git\n/guest/checkout/.git\n/guest/checkout\n',
            stderr: '',
            exitCode: 0,
          }
    const guestStore = new MemoryBuildStore()
    await guestStore.createBuild({
      slug: 'guest',
      repo: '/host/checkout',
      repoOrigin: 'https://github.com/acme/app',
    })
    await guestStore.putArtifact('guest', { kind: 'evidence', content: 'from the guest' })

    const output = join(tmp, 'guest.bin')
    const result = await artifactDownload({
      targetRepo: '/guest/checkout',
      env: {},
      exec,
      build: 'guest',
      spec: 'evidence',
      outputPath: output,
      openStore: () => guestStore,
    })
    expect(result.outputPath).toBe(resolve(output))
    expect(await Bun.file(output).text()).toBe('from the guest')

    await guestStore.createBuild({
      slug: 'foreign-origin',
      repo: '/host/checkout',
      repoOrigin: 'https://github.com/other/app',
    })
    await guestStore.createBuild({ slug: 'legacy', repo: '/host/checkout' })
    for (const slug of ['foreign-origin', 'legacy']) {
      const rejected = join(tmp, `${slug}.bin`)
      await expect(
        artifactDownload({
          targetRepo: '/guest/checkout',
          env: {},
          exec,
          build: slug,
          spec: 'evidence',
          outputPath: rejected,
          openStore: () => guestStore,
        }),
      ).rejects.toThrow(
        `build "${slug}" belongs to repository "/host/checkout", not "https://github.com/acme/app"`,
      )
      expect(await Bun.file(rejected).exists()).toBe(false)
    }
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
    await expect(artifactDownload({ ...common, build: '  ', spec: 'frame' })).rejects.toThrow(
      /non-empty <build>/,
    )
    await expect(artifactDownload({ ...common, build: 'build', spec: '  ' })).rejects.toThrow(
      /non-empty <kind>/,
    )
    expect(opens).toBe(0)
  })
})

describe('artifact download stream:<id>', () => {
  const REPO = () => resolve(tmp)

  /** A closed repo-scoped stream whose close deposited `stream:<id>@0`. */
  async function seedClosedStream(
    parts: Array<{ type: string } & Record<string, unknown>> = [{ type: 'unknown-part' }],
  ): Promise<string> {
    await store.ensureRepo(REPO())
    const stream = await store.createStream({ kind: 'repo', repo: REPO() }, 'session:hs_1')
    await store.appendStreamParts(stream.id, parts)
    await store.closeStream(stream.id, 'completed')
    return stream.id
  }

  function streamOpts(streamId: string, outputPath: string) {
    return {
      targetRepo: tmp,
      env: {},
      exec: spawnExec,
      spec: `stream:${streamId}`,
      outputPath,
      openStore: () => store,
    }
  }

  test('retrieves the exact finalized-document bytes; @0 pin works; the store closes once', async () => {
    let closeCount = 0
    store.close = async () => {
      closeCount += 1
    }
    const streamId = await seedClosedStream()
    const output = join(tmp, 'downloads', 'session.json')

    const result = await artifactDownloadStream(streamOpts(streamId, output))
    expect(result.artifact.meta.kind).toBe(`stream:${streamId}`)
    expect(result.artifact.meta.revision).toBe(0)
    expect(result.outputPath).toBe(output)
    const stored = await store.getRepoArtifact(REPO(), `stream:${streamId}`)
    expect(stored).not.toBeNull()
    expect(new Uint8Array(await readFile(output))).toEqual(new Uint8Array(stored!.content))
    expect(closeCount).toBe(1)

    const pinned = join(tmp, 'pinned.json')
    await artifactDownloadStream({ ...streamOpts(streamId, pinned), spec: `stream:${streamId}@0` })
    expect(new Uint8Array(await readFile(pinned))).toEqual(new Uint8Array(stored!.content))
    expect(closeCount).toBe(2)
  })

  test('complete ambient build or Harvest identity fails closed before any store read (§8.2)', async () => {
    const streamId = await seedClosedStream()
    let opens = 0
    const common = {
      targetRepo: tmp,
      exec: spawnExec,
      spec: `stream:${streamId}`,
      outputPath: join(tmp, 'denied.json'),
      openStore: () => {
        opens += 1
        return store
      },
    }
    await expect(
      artifactDownloadStream({
        ...common,
        env: {
          AB_STORE: '/phase/store',
          AB_BUILD: 'auth-rate-limit',
          AB_PHASE: 'implement@1',
          AB_SESSION: 's_phase',
        },
      }),
    ).rejects.toThrow(/operator reads.*§8\.2.*never extends/s)
    await expect(
      artifactDownloadStream({
        ...common,
        env: {
          AB_STORE: '/phase/store',
          AB_REPO: REPO(),
          AB_HARVEST: 'h_1',
          AB_PHASE: 'synthesize@1',
          AB_SESSION: 'hs_1',
        },
      }),
    ).rejects.toThrow(/operator reads.*§8\.2.*never extends/s)
    expect(opens).toBe(0)
    expect(await Bun.file(common.outputPath).exists()).toBe(false)
  })

  test('unknown stream ids, open streams, foreign repos, and non-repo scopes name the fix', async () => {
    const output = join(tmp, 'unused.json')

    await expect(artifactDownloadStream(streamOpts('st_nope', output))).rejects.toThrow(
      'no stream "st_nope" in this store',
    )

    await store.ensureRepo(REPO())
    const open = await store.createStream({ kind: 'repo', repo: REPO() }, 'session:hs_2')
    await store.appendStreamParts(open.id, [{ type: 'start', messageId: 'm1' }])
    await expect(artifactDownloadStream(streamOpts(open.id, output))).rejects.toThrow(
      `stream "${open.id}" is open — its finalized artifact exists only after the stream closes (§7.6)`,
    )

    await store.ensureRepo('/other/repo')
    const foreign = await store.createStream({ kind: 'repo', repo: '/other/repo' }, 'session:hs_3')
    await store.appendStreamParts(foreign.id, [{ type: 'start', messageId: 'm1' }])
    await store.closeStream(foreign.id, 'completed')
    await expect(artifactDownloadStream(streamOpts(foreign.id, output))).rejects.toThrow(
      `stream "${foreign.id}" belongs to repository "/other/repo", not "${REPO()}"`,
    )

    const buildStream = await store.createStream(
      { kind: 'build', build: 'auth-rate-limit' },
      'session:s_1',
    )
    await expect(artifactDownloadStream(streamOpts(buildStream.id, output))).rejects.toThrow(
      `stream "${buildStream.id}" is build-scoped — download it with 'ab artifact download auth-rate-limit stream:${buildStream.id}'`,
    )

    await store.createSession({ repo: REPO(), operator: 'op' })
    const sessions = await store.listSessions(REPO())
    const sessionStream = await store.createStream(
      { kind: 'session', session: sessions[0]!.id },
      'turn',
    )
    await expect(artifactDownloadStream(streamOpts(sessionStream.id, output))).rejects.toThrow(
      `stream "${sessionStream.id}" is session-scoped`,
    )
    expect(await Bun.file(output).exists()).toBe(false)
  })

  test('a missing finalized artifact names the available refs for the stream kind', async () => {
    await store.ensureRepo(REPO())
    const stream = await store.createStream({ kind: 'repo', repo: REPO() }, 'session:hs_4')
    await store.appendStreamParts(stream.id, [{ type: 'start', messageId: 'm1' }])
    await store.closeStream(stream.id, 'completed')
    // Directly depositing under the stream kind is impossible through the
    // stream API without chunks, so force the miss by pinning an absent rev.
    await expect(
      artifactDownloadStream({
        ...streamOpts(stream.id, join(tmp, 'x.json')),
        spec: `stream:${stream.id}@3`,
      }),
    ).rejects.toThrow(`no "stream:${stream.id}" artifact at rev 3 in repository "${REPO()}"`)
  })

  test('validates the stream ref before opening a store', async () => {
    let opens = 0
    await expect(
      artifactDownloadStream({
        targetRepo: tmp,
        env: {},
        exec: spawnExec,
        spec: 'stream:',
        outputPath: join(tmp, 'x.json'),
        openStore: () => {
          opens += 1
          return store
        },
      }),
    ).rejects.toThrow(/invalid stream ref "stream:"/)
    await expect(
      artifactDownloadStream({
        targetRepo: tmp,
        env: {},
        exec: spawnExec,
        spec: 'st_nope',
        outputPath: join(tmp, 'x.json'),
        openStore: () => {
          opens += 1
          return store
        },
      }),
    ).rejects.toThrow(/invalid stream ref "st_nope"/)
    expect(opens).toBe(0)
  })

  test('the unchanged build-scoped path still rejects a repo-scoped stream kind exactly as today', async () => {
    const streamId = await seedClosedStream()
    await store.createBuild({ slug: 'stream-host', repo: REPO() })
    await store.putArtifact('stream-host', { kind: 'spec', content: 'spec bytes' })
    const output = join(tmp, 'still-no.json')
    await expect(
      artifactDownload({
        targetRepo: tmp,
        env: {},
        exec: spawnExec,
        build: 'stream-host',
        spec: `stream:${streamId}`,
        outputPath: output,
        openStore: () => store,
      }),
    ).rejects.toThrow(
      `no "stream:${streamId}" artifact in build "stream-host" — available refs: spec@0`,
    )
    expect(await Bun.file(output).exists()).toBe(false)

    // A nonexistent build named like a stream path is untouched behavior.
    await expect(
      artifactDownload({
        targetRepo: tmp,
        env: {},
        exec: spawnExec,
        build: 'stream:not-a-build',
        spec: 'spec',
        outputPath: output,
        openStore: () => store,
      }),
    ).rejects.toThrow('no build "stream:not-a-build"')
  })

  test('accepts origin-equivalent scope.repo spellings; a legacy physical-path scope stays rejected', async () => {
    // Mirror the build-scoped origin test's guest: the checkout's origin
    // remote is ssh-spelled, so `context.repo` resolves to the https form.
    const exec: Exec = async (cmd) =>
      cmd[1] === 'remote'
        ? { stdout: 'git@github.com:acme/app.git\n', stderr: '', exitCode: 0 }
        : {
            stdout: '/guest/checkout/.git\n/guest/checkout/.git\n/guest/checkout\n',
            stderr: '',
            exitCode: 0,
          }
    const ORIGIN = 'https://github.com/acme/app'
    const guestStore = new MemoryBuildStore()

    const seed = async (scopeRepo: string): Promise<string> => {
      await guestStore.ensureRepo(scopeRepo)
      const stream = await guestStore.createStream(
        { kind: 'repo', repo: scopeRepo },
        'session:hs_9',
      )
      await guestStore.appendStreamParts(stream.id, [{ type: 'start', messageId: 'm1' }])
      await guestStore.closeStream(stream.id, 'completed')
      return stream.id
    }

    const opts = (streamId: string, outputPath: string) => ({
      targetRepo: '/guest/checkout',
      env: {},
      exec,
      spec: `stream:${streamId}`,
      outputPath,
      openStore: () => guestStore,
    })

    // The scope recorded in the normalized https form downloads normally.
    const canonical = await seed(ORIGIN)
    const canonicalOut = join(tmp, 'origin-canonical.json')
    const canonicalResult = await artifactDownloadStream(opts(canonical, canonicalOut))
    expect(canonicalResult.outputPath).toBe(resolve(canonicalOut))

    // The same origin spelled scp-like ssh also downloads: the membership
    // guard normalizes the recorded side like `buildInRepository` normalizes
    // `record.repoOrigin`, so writer vintage no longer decides membership.
    const scp = await seed('git@github.com:acme/app.git')
    const scpOut = join(tmp, 'origin-scp.json')
    const scpResult = await artifactDownloadStream(opts(scp, scpOut))
    expect(scpResult.outputPath).toBe(resolve(scpOut))

    // A legacy physical-path scope stays rejected: StreamScope carries no
    // `repoOrigin`, so the recorded origin is unrecoverable and the guard
    // cannot forgive the mismatch (the accepted AUT-314-class limitation).
    const legacy = await seed('/host/checkout')
    const legacyOut = join(tmp, 'legacy.json')
    await expect(artifactDownloadStream(opts(legacy, legacyOut))).rejects.toThrow(
      `stream "${legacy}" belongs to repository "/host/checkout", not "${ORIGIN}"`,
    )
    expect(await Bun.file(legacyOut).exists()).toBe(false)
  })
})
