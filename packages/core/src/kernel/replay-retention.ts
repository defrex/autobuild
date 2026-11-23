import { createHash } from 'node:crypto'
import type { RestackDeps } from './reconcile-restack'
import type { BuildStore } from '../store/types'

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
/** A retained copy whose bytes cannot reconstruct the commit they name. */
export class RetainedCopyInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetainedCopyInvalid'
  }
}
type ObjectDeps = Pick<RestackDeps, 'store' | 'slug' | 'exec' | 'workspacePath'>
function parse(content: Uint8Array): Manifest | string {
  const text = new TextDecoder().decode(content)
  if (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) &&
    text.length > 0
  )
    return text
  let m: Manifest
  try {
    m = JSON.parse(text) as Manifest
  } catch {
    throw new RetainedCopyInvalid('invalid retained replay manifest')
  }
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
    throw new RetainedCopyInvalid('invalid retained replay manifest')
  return m
}
/** Replay results: a thin pack of `head ^base` whose head's parent is base. */
const REPLAY = 'replay-objects-'
/** Displaced leaf history the forge refused to archive: a thin pack of the
 * objects `sha` reaches that the published target base does not. */
const HISTORY = 'history-objects-'
const chunkKind = (m: Manifest, i: number) => `replay-v1-${m.digest}-${i}`
async function run(deps: ObjectDeps, args: string[]) {
  const r = await deps.exec(args, { cwd: deps.workspacePath })
  if (r.exitCode !== 0) throw new Error(`replay command failed: ${r.stderr}`)
  return r.stdout.trim()
}
async function present(deps: ObjectDeps, head: string) {
  return (
    (await deps.exec(['git', 'cat-file', '-e', `${head}^{commit}`], { cwd: deps.workspacePath }))
      .exitCode === 0
  )
}
async function scratch(deps: ObjectDeps) {
  return run(deps, ['sh', '-c', 'mkdir -p .ab/replay && mktemp .ab/replay/pack.XXXXXXXX'])
}
async function stage(deps: ObjectDeps, path: string, bytes: Uint8Array) {
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
    throw new RetainedCopyInvalid('retained replay identity mismatch')
}
/** Completion is published last; incomplete digest-keyed chunks are never a
 * copy. Chunks are content-addressed, so every manifest kind shares them. */
async function retainObjects(deps: ObjectDeps, prefix: string, head: string, base: string) {
  if (!shaPattern.test(head) || !shaPattern.test(base)) throw new Error('invalid replay identity')
  const completed = await deps.store.getArtifact(deps.slug, `${prefix}${head}`)
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
    const prior = await deps.store.getArtifact(deps.slug, `${prefix}${head}`)
    if (prior !== null) validateIdentity(parse(prior.content), head, base)
    else
      await deps.store.putArtifact(deps.slug, {
        kind: `${prefix}${head}`,
        content: JSON.stringify(m),
      })
  } finally {
    await run(deps, ['rm', '-f', path])
  }
}

/** Reassemble a retained copy's pack bytes, verifying length and digest. */
async function packBytes(
  store: BuildStore,
  slug: string,
  m: Manifest | string,
): Promise<Uint8Array[]> {
  if (typeof m === 'string') return [Buffer.from(m, 'base64')]
  const hash = createHash('sha256')
  const chunks: Uint8Array[] = []
  for (let i = 0; i < m.chunks; i++) {
    const chunk = await store.getArtifact(slug, chunkKind(m, i))
    const expected = Math.min(m.chunkBytes, m.bytes - i * m.chunkBytes)
    if (chunk === null || chunk.content.length !== expected)
      throw new RetainedCopyInvalid('missing or truncated retained replay chunk')
    hash.update(chunk.content)
    chunks.push(chunk.content)
  }
  if (hash.digest('hex') !== m.digest)
    throw new RetainedCopyInvalid('retained replay digest mismatch')
  return chunks
}

async function restoreObjects(
  deps: ObjectDeps,
  prefix: string,
  head: string,
  options: { requireBase: boolean; verify: (m: Manifest) => Promise<void> },
): Promise<boolean> {
  if (!shaPattern.test(head)) throw new Error('invalid replay identity')
  if (await present(deps, head)) return true
  const artifact = await deps.store.getArtifact(deps.slug, `${prefix}${head}`)
  if (artifact === null) return false
  const m = parse(artifact.content)
  validateIdentity(m, head)
  // A thin pack completes its deltas only from objects already present.
  if (options.requireBase && typeof m !== 'string' && !(await present(deps, m.base))) return false
  const path = await scratch(deps)
  try {
    if (typeof m === 'string') await stage(deps, path, Buffer.from(m, 'base64'))
    else
      for (const chunk of await packBytes(deps.store, deps.slug, m)) await stage(deps, path, chunk)
    await run(deps, [
      'sh',
      '-c',
      typeof m === 'string'
        ? 'git unpack-objects -q < "$1"'
        : 'git index-pack --stdin --fix-thin < "$1"',
      'restore-replay',
      path,
    ])
    if (!(await present(deps, head)))
      throw new RetainedCopyInvalid('retained replay commit missing')
    if (typeof m !== 'string') await options.verify(m)
    return true
  } finally {
    await run(deps, ['rm', '-f', path])
  }
}

export async function retainReplay(deps: ObjectDeps, head: string, base: string) {
  return retainObjects(deps, REPLAY, head, base)
}

export async function restoreReplay(deps: ObjectDeps, head: string): Promise<boolean> {
  return restoreObjects(deps, REPLAY, head, {
    requireBase: false,
    verify: async (m) => {
      if ((await run(deps, ['git', 'show', '-s', '--format=%P', head])) !== m.base)
        throw new RetainedCopyInvalid('retained replay parent mismatch')
    },
  })
}

/** Keep `sha` as a BuildStore copy of only the objects it reaches that the
 * published `exclude` does not. Idempotent per sha. */
export async function retainHistoryCopy(deps: ObjectDeps, sha: string, exclude: string) {
  return retainObjects(deps, HISTORY, sha, exclude)
}

/** False when no copy exists or its exclusion base is not present locally;
 * the caller fetches the published target and tries again. */
export async function restoreHistoryCopy(deps: ObjectDeps, sha: string): Promise<boolean> {
  return restoreObjects(deps, HISTORY, sha, {
    requireBase: true,
    verify: async (m) => {
      // Connectivity: every object the copy claims is now reachable.
      await run(deps, ['git', 'rev-list', '--objects', '--quiet', sha, `^${m.base}`])
    },
  })
}

/** Try every store copy of `sha` usable without network: a replay result,
 * then displaced history. Unusable copies count as absent. */
export async function restoreRetainedCopy(deps: ObjectDeps, sha: string): Promise<boolean> {
  for (const [prefix, verifyParent] of [
    [REPLAY, true],
    [HISTORY, false],
  ] as const) {
    try {
      const restored = await restoreObjects(deps, prefix, sha, {
        requireBase: true,
        verify: async (m) => {
          if (verifyParent) {
            if ((await run(deps, ['git', 'show', '-s', '--format=%P', sha])) !== m.base)
              throw new RetainedCopyInvalid('retained replay parent mismatch')
          } else await run(deps, ['git', 'rev-list', '--objects', '--quiet', sha, `^${m.base}`])
        },
      })
      if (restored) return true
    } catch (error) {
      if (!(error instanceof RetainedCopyInvalid)) throw error
    }
  }
  return false
}

/** The verified pack bytes of a candidate's store copy, for probes that run
 * where the store is unreachable. `base` is the thin pack's exclusion base,
 * which must be present before applying it; legacy packs are complete and
 * carry none. Throws when a copy exists but is corrupt or truncated. */
export async function readRetainedPack(
  store: BuildStore,
  slug: string,
  sha: string,
): Promise<{ pack: Uint8Array; base?: string } | null> {
  for (const prefix of [REPLAY, HISTORY]) {
    const artifact = await store.getArtifact(slug, `${prefix}${sha}`)
    if (artifact === null) continue
    const m = parse(artifact.content)
    validateIdentity(m, sha)
    const pack = Buffer.concat(await packBytes(store, slug, m))
    return typeof m === 'string' ? { pack } : { pack, base: m.base }
  }
  return null
}

/** Restore a prepared reconcile change's exact commit object from its
 * durable bytes. False when no such copy was written. */
export async function restoreChangeCommit(deps: ObjectDeps, sha: string): Promise<boolean> {
  const artifact = await deps.store.getArtifact(deps.slug, `reconcile-change-${sha}`)
  if (artifact === null) return false
  const content = new TextDecoder().decode(artifact.content)
  const quoted = `'${content.replaceAll("'", "'\\''")}'`
  const result = await deps.exec(
    ['sh', '-c', `printf %s ${quoted} | git hash-object -t commit -w --stdin`],
    { cwd: deps.workspacePath },
  )
  if (result.exitCode !== 0 || result.stdout.trim() !== sha)
    throw new Error(`durable replay object ${sha} failed integrity verification`)
  return true
}
