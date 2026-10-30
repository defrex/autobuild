import { createHash } from 'node:crypto'
import type { RestackDeps } from './reconcile-restack'

export const REPLAY_CHUNK_BYTES = 1024 * 1024
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
interface Manifest {
  version: 1
  head: string
  base: string
  digest: string
  bytes: number
  chunkBytes: number
  chunks: number
}
function parse(content: Uint8Array): Manifest | string {
  const text = new TextDecoder().decode(content)
  if (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) &&
    text.length > 0
  )
    return text
  const m = JSON.parse(text) as Manifest
  if (
    text.length > 1024 ||
    m === null ||
    typeof m !== 'object' ||
    Object.keys(m).sort().join(',') !== 'base,bytes,chunkBytes,chunks,digest,head,version' ||
    m.version !== 1 ||
    !shaPattern.test(m.head) ||
    !shaPattern.test(m.base) ||
    !/^[a-f0-9]{64}$/.test(m.digest) ||
    !Number.isSafeInteger(m.bytes) ||
    m.bytes <= 0 ||
    m.chunkBytes !== REPLAY_CHUNK_BYTES ||
    !Number.isSafeInteger(m.chunks) ||
    m.chunks !== Math.ceil(m.bytes / REPLAY_CHUNK_BYTES)
  )
    throw new Error('invalid retained replay manifest')
  return m
}
const kind = (head: string) => `replay-objects-${head}`
const chunkKind = (m: Manifest, i: number) => `replay-v1-${m.digest}-${i}`
async function run(deps: RestackDeps, args: string[]) {
  const r = await deps.exec(args, { cwd: deps.workspacePath })
  if (r.exitCode !== 0) throw new Error(`replay command failed: ${r.stderr}`)
  return r.stdout.trim()
}
async function present(deps: RestackDeps, head: string) {
  return (
    (await deps.exec(['git', 'cat-file', '-e', `${head}^{commit}`], { cwd: deps.workspacePath }))
      .exitCode === 0
  )
}
async function scratch(deps: RestackDeps) {
  return run(deps, ['sh', '-c', 'mkdir -p .ab/replay && mktemp .ab/replay/pack.XXXXXXXX'])
}
async function stage(deps: RestackDeps, path: string, bytes: Uint8Array) {
  // Keep Exec arguments bounded as well as store requests.
  for (let offset = 0; offset < bytes.length; offset += 12288)
    await run(deps, [
      'bash',
      '-o',
      'pipefail',
      '-c',
      'printf %s "$1" | base64 -d >> "$2"',
      'stage-replay',
      Buffer.from(bytes.subarray(offset, offset + 12288)).toString('base64'),
      path,
    ])
}
function validateIdentity(m: Manifest | string, head: string, base?: string) {
  if (typeof m !== 'string' && (m.head !== head || (base !== undefined && m.base !== base)))
    throw new Error('retained replay identity mismatch')
}
/** Completion is published last; incomplete digest-keyed chunks are never a replay. */
export async function retainReplay(deps: RestackDeps, head: string, base: string) {
  if (!shaPattern.test(head) || !shaPattern.test(base)) throw new Error('invalid replay identity')
  const completed = await deps.store.getArtifact(deps.slug, kind(head))
  if (completed !== null) {
    validateIdentity(parse(completed.content), head, base)
    return
  }
  const path = await scratch(deps)
  try {
    await run(deps, [
      'bash',
      '-o',
      'pipefail',
      '-c',
      'printf "%s\\n" "$1" "^$2" | git -c core.bigFileThreshold=2g pack-objects --stdout --revs --thin --window=50 --depth=50 --threads=1 --no-reuse-delta --no-reuse-object > "$3"',
      'retain-replay',
      head,
      base,
      path,
    ])
    const bytes = Number(await run(deps, ['sh', '-c', 'wc -c < "$1"', 'pack-size', path]))
    const digest = (await run(deps, ['sha256sum', path])).split(' ')[0]!
    const m: Manifest = {
      version: 1,
      head,
      base,
      digest,
      bytes,
      chunkBytes: REPLAY_CHUNK_BYTES,
      chunks: Math.ceil(bytes / REPLAY_CHUNK_BYTES),
    }
    parse(new TextEncoder().encode(JSON.stringify(m)))
    for (let i = 0; i < m.chunks; i++) {
      const encoded = await run(deps, [
        'bash',
        '-o',
        'pipefail',
        '-c',
        'dd if="$1" bs=1048576 skip="$2" count=1 status=none | base64 -w0',
        'read-replay',
        path,
        String(i),
      ])
      const content = Buffer.from(encoded, 'base64')
      const prior = await deps.store.getArtifact(deps.slug, chunkKind(m, i))
      if (prior !== null) {
        if (!Buffer.from(prior.content).equals(content))
          throw new Error('conflicting retained replay chunk')
      } else await deps.store.putArtifact(deps.slug, { kind: chunkKind(m, i), content })
    }
    const prior = await deps.store.getArtifact(deps.slug, kind(head))
    if (prior !== null) validateIdentity(parse(prior.content), head, base)
    else await deps.store.putArtifact(deps.slug, { kind: kind(head), content: JSON.stringify(m) })
  } finally {
    await run(deps, ['rm', '-f', path])
  }
}

export async function restoreReplay(deps: RestackDeps, head: string): Promise<boolean> {
  if (!shaPattern.test(head)) throw new Error('invalid replay identity')
  if (await present(deps, head)) return true
  const artifact = await deps.store.getArtifact(deps.slug, kind(head))
  if (artifact === null) return false
  const m = parse(artifact.content)
  validateIdentity(m, head)
  const path = await scratch(deps)
  try {
    if (typeof m === 'string') {
      await stage(deps, path, Buffer.from(m, 'base64'))
    } else {
      const hash = createHash('sha256')
      for (let i = 0; i < m.chunks; i++) {
        const chunk = await deps.store.getArtifact(deps.slug, chunkKind(m, i))
        const expected = Math.min(m.chunkBytes, m.bytes - i * m.chunkBytes)
        if (chunk === null || chunk.content.length !== expected)
          throw new Error('missing or truncated retained replay chunk')
        hash.update(chunk.content)
        await stage(deps, path, chunk.content)
      }
      if (hash.digest('hex') !== m.digest) throw new Error('retained replay digest mismatch')
    }
    await run(deps, [
      'sh',
      '-c',
      typeof m === 'string'
        ? 'git unpack-objects -q < "$1"'
        : 'git index-pack --stdin --fix-thin < "$1"',
      'restore-replay',
      path,
    ])
    if (!(await present(deps, head))) throw new Error('retained replay commit missing')
    if (
      typeof m !== 'string' &&
      (await run(deps, ['git', 'show', '-s', '--format=%P', head])) !== m.base
    )
      throw new Error('retained replay parent mismatch')
    return true
  } finally {
    await run(deps, ['rm', '-f', path])
  }
}
