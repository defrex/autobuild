import { afterEach, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { temporaryDirectories } from '../testing/temp-directories'
import { seedStore, BUILD } from '../cli/testkit'
import { bunExec } from '../ports/forge/github'
import { RemoteBuildStore } from '../store/remote/client'
import { FakeForge } from '../ports/forge/fake'
import { retainReplay, restoreReplay, REPLAY_CHUNK_BYTES } from './replay-retention'

const temporary = temporaryDirectories(afterEach)
function noise(size: number) {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i += 32) createHash('sha256').update(String(i)).digest().copy(bytes, i)
  return bytes
}
for (const large of [false, true])
  test(`replay chunks recover exact SHA, retry and local read budget (${large})`, async () => {
    const cwd = await temporary(join(tmpdir(), 'replay-'))
    const fresh = await temporary(join(tmpdir(), 'replay-fresh-'))
    async function git(args: string[], path = cwd) {
      const r = await bunExec(['git', ...args], { cwd: path })
      if (r.exitCode !== 0) throw new Error(r.stderr)
      return r.stdout.trim()
    }
    await git(['init', '-q'])
    await git(['config', 'user.name', 'Test'])
    await git(['config', 'user.email', 'test@example.invalid'])
    await git(['config', 'commit.gpgsign', 'false'])
    const data = noise(large ? 7 * REPLAY_CHUNK_BYTES : 4 * REPLAY_CHUNK_BYTES)
    await writeFile(join(cwd, 'data'), large ? 'base' : data)
    await git(['add', '.'])
    await git(['commit', '-qm', 'base'])
    const base = await git(['rev-parse', 'HEAD'])
    await git(['clone', '-q', '--no-local', cwd, fresh])
    if (!large) data.write('small edit', 100)
    await writeFile(join(cwd, 'data'), data)
    await git(['add', '.'])
    await git(['commit', '-qm', 'head'])
    const head = await git(['rev-parse', 'HEAD'])
    await git(['config', 'core.bigFileThreshold', '1'])
    const store = await seedStore()
    const originalPut = store.putArtifact.bind(store)
    let writes = 0
    let failManifest = false
    let fail = large
    store.putArtifact = async (slug, input) => {
      const bytes =
        typeof input.content === 'string' ? Buffer.byteLength(input.content) : input.content.length
      expect(bytes).toBeLessThanOrEqual(REPLAY_CHUNK_BYTES)
      expect(
        Buffer.byteLength(
          JSON.stringify({ ...input, content: Buffer.from(input.content).toString('base64') }),
        ),
      ).toBeLessThan(4_500_000)
      const result = await originalPut(slug, input)
      writes++
      if (fail) {
        fail = false
        throw new Error('lost response')
      }
      if (failManifest && input.kind.startsWith('replay-objects-')) {
        failManifest = false
        throw new Error('lost completion response')
      }
      return result
    }
    const remote = new RemoteBuildStore({
      url: 'https://store.invalid',
      fetchFn: (async (input, init) => {
        const url = new URL(String(input))
        expect(url.href.length).toBeLessThan(1024)
        if (init?.method === 'POST') {
          expect(Buffer.byteLength(String(init.body))).toBeLessThan(4_500_000)
          const body = JSON.parse(String(init.body))
          const content = Buffer.from(body.contentBase64, 'base64')
          expect(content.length).toBeLessThan(2.5 * 1024 * 1024)
          return Response.json(await store.putArtifact(BUILD, { kind: body.kind, content }))
        }
        const artifact = await store.getArtifact(BUILD, url.searchParams.get('kind')!)
        return Response.json(
          artifact === null
            ? null
            : {
                meta: artifact.meta,
                contentBase64: Buffer.from(artifact.content).toString('base64'),
              },
        )
      }) as typeof fetch,
    })
    const deps = {
      store: remote,
      slug: BUILD,
      workspacePath: cwd,
      exec: bunExec,
      forge: new FakeForge(),
    }
    if (large) {
      await expect(retainReplay(deps, head, base)).rejects.toThrow('lost response')
      expect(await restoreReplay({ ...deps, workspacePath: fresh }, head)).toBe(false)
    }
    if (large) {
      failManifest = true
      await expect(retainReplay(deps, head, base)).rejects.toThrow('lost completion response')
      const acceptedWrites = writes
      await retainReplay(deps, head, base)
      expect(writes).toBe(acceptedWrites)
    } else await retainReplay(deps, head, base)
    const completed = await store.getArtifact(BUILD, `replay-objects-${head}`)
    const manifest = JSON.parse(new TextDecoder().decode(completed!.content))
    expect(manifest.bytes).toBeLessThan(large ? 8 * REPLAY_CHUNK_BYTES : data.length / 10)
    expect(manifest.chunks).toBe(large ? 8 : 1)
    const savedWrites = writes
    await retainReplay(deps, head, base)
    expect(writes).toBe(savedWrites)
    const originalGet = store.getArtifact.bind(store)
    for (const patch of [
      { version: 2 },
      { head: 'f'.repeat(40) },
      { chunks: manifest.chunks + 1 },
      { digest: 'invalid' },
      { bytes: 0 },
    ]) {
      store.getArtifact = async (slug, kind, rev) => {
        const artifact = await originalGet(slug, kind, rev)
        return artifact !== null && kind === `replay-objects-${head}`
          ? {
              ...artifact,
              content: new TextEncoder().encode(JSON.stringify({ ...manifest, ...patch })),
            }
          : artifact
      }
      await expect(restoreReplay({ ...deps, workspacePath: fresh }, head)).rejects.toThrow()
    }
    store.getArtifact = originalGet

    store.getArtifact = async (slug, kind, rev) => {
      const result = await originalGet(slug, kind, rev)
      if (result !== null && kind.startsWith('replay-v1-')) {
        const content = Uint8Array.from(result.content)
        content[0] = content[0]! ^ 1
        return { ...result, content }
      }
      return result
    }
    await expect(restoreReplay({ ...deps, workspacePath: fresh }, head)).rejects.toThrow(
      'digest mismatch',
    )
    store.getArtifact = originalGet
    if (!large) {
      const legacyWorkspace = await temporary(join(tmpdir(), 'replay-legacy-'))
      await git(['clone', '-q', '--no-local', fresh, legacyWorkspace])
      const packed = await bunExec(
        [
          'bash',
          '-o',
          'pipefail',
          '-c',
          'printf "%s\\n" "$1" "^$2" | git pack-objects --stdout --revs | base64 -w0',
          'legacy-pack',
          head,
          base,
        ],
        { cwd },
      )
      expect(packed.exitCode).toBe(0)
      const legacyStore = await seedStore()
      await legacyStore.putArtifact(BUILD, {
        kind: `replay-objects-${head}`,
        content: packed.stdout.trim(),
      })
      expect(
        await restoreReplay({ ...deps, store: legacyStore, workspacePath: legacyWorkspace }, head),
      ).toBe(true)
    }
    expect(await restoreReplay({ ...deps, workspacePath: fresh }, head)).toBe(true)
    expect(await git(['rev-parse', `${head}^{tree}`], fresh)).toBe(
      await git(['rev-parse', `${head}^{tree}`]),
    )
    store.getArtifact = async () => {
      throw new Error('unexpected store read')
    }
    expect(await restoreReplay({ ...deps, workspacePath: fresh }, head)).toBe(true)
  }, 60_000)
