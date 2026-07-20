/**
 * Artifact command core (SPEC §8.2). In-session `put|get` are own-build by
 * construction: their store handle and remote token come from the phase tuple.
 * Sessionless `download` is the read-only operator path; it resolves and
 * verifies the repository/build explicitly and writes exact bytes to a file.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { RemoteBuildStore } from '../store/remote/client'
import type { Artifact, ArtifactMeta, BuildStore } from '../store/types'
import type { CliEnv } from './env'
import { resolveRepoState } from './repo-state'
import { resolveStore } from './store-ref'

export interface ArtifactDeps {
  store: BuildStore
  env: CliEnv
}

/** `plan@1` → `{kind: 'plan', rev: 1}`; no `@` → latest (rev omitted). */
export function parseArtifactSpec(spec: string): { kind: string; rev?: number } {
  const at = spec.lastIndexOf('@')
  if (at === -1) return { kind: spec }
  const kind = spec.slice(0, at)
  const revPart = spec.slice(at + 1)
  if (kind === '' || !/^\d+$/.test(revPart)) {
    throw new Error(
      `invalid artifact ref "${spec}" — expected '<kind>' or '<kind>@<rev>' ` +
        '(rev is a nonnegative integer; revisions are 0-based, §6.3)',
    )
  }
  return { kind, rev: Number(revPart) }
}

/** Deposit a revision of `kind` from `filePath`; the caller prints the rev. */
export async function artifactPut(
  deps: ArtifactDeps,
  kind: string,
  filePath: string,
): Promise<ArtifactMeta> {
  if (kind.trim() === '') {
    throw new Error("'ab artifact put' requires a non-empty <kind> (§8.2)")
  }
  // §6.3 immutability: the spec cannot change during a build. It enters via
  // dispatch (spec.imported / spec.authored — dispatcher plumbing, never this
  // CLI) and changes only through a human-answered escalation (spec.revised).
  // Without this gate, any phase's agent could silently swap the contract
  // every later reviewer approves conformance to.
  if (kind === 'spec') {
    throw new Error(
      "'ab artifact put spec' is rejected: the spec is immutable during a build " +
        '(§6.3) — a phase that finds the spec itself wrong should raise ' +
        "'ab escalate' so a human can revise it (spec.revised restarts from plan).",
    )
  }
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    throw new Error(`'ab artifact put ${kind}': file not found: ${filePath}`)
  }
  // Artifacts are byte streams. Text deposits remain byte-for-byte compatible,
  // while PNG and other binary evidence must never pass through UTF-8 decode.
  const content = await file.bytes()
  return deps.store.putArtifact(deps.env.build, { kind, content })
}

/** Fetch `<kind>[@rev]` within the own build; latest when rev is omitted. */
export async function artifactGet(
  deps: ArtifactDeps,
  spec: string,
): Promise<Artifact> {
  const { kind, rev } = parseArtifactSpec(spec)
  const artifact = await deps.store.getArtifact(deps.env.build, kind, rev)
  if (artifact === null) {
    const metas = await deps.store.listArtifacts(deps.env.build)
    const kinds = [...new Set(metas.map((meta) => meta.kind))]
    throw new Error(
      `no "${kind}" artifact${rev !== undefined ? ` at rev ${rev}` : ''} in ` +
        `build "${deps.env.build}" — deposited kinds: ${kinds.join(', ') || '(none)'}`,
    )
  }
  return artifact
}

export interface ArtifactDownloadOpts {
  /** Current checkout; repository identity resolves to its main worktree. */
  targetRepo: string
  env: Record<string, string | undefined>
  exec: Exec
  build: string
  spec: string
  outputPath: string
  /** Explicit --store; precedence remains flag > AB_STORE > local default. */
  storeRef?: string
  /** Adapter seam for local/remote selection tests. */
  openStore?: (ref: string, token?: string) => BuildStore
}

export interface ArtifactDownloadResult {
  artifact: Artifact
  outputPath: string
}

/** Read-only, sessionless binary retrieval. It deliberately accepts terminal
 * builds: artifacts are evidence, not a control operation. */
export async function artifactDownload(
  opts: ArtifactDownloadOpts,
): Promise<ArtifactDownloadResult> {
  if (opts.build.trim() === '') {
    throw new Error("'ab artifact download' requires a non-empty <build>")
  }
  const { kind, rev } = parseArtifactSpec(opts.spec)
  if (kind.trim() === '') {
    throw new Error(
      "'ab artifact download' requires a non-empty <kind>[@rev]",
    )
  }
  const state = await resolveRepoState({
    targetRepo: opts.targetRepo,
    exec: opts.exec,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.env['AB_STORE'] !== undefined
      ? { envStore: opts.env['AB_STORE'] }
      : {}),
  })
  const token = opts.env['AB_TOKEN']?.trim()
  const open =
    opts.openStore ??
    ((ref: string, scopedToken?: string) =>
      resolveStore(ref, {
        remoteFactory: (url, remoteToken) =>
          new RemoteBuildStore({ url, token: remoteToken }),
        ...(scopedToken !== undefined && scopedToken !== ''
          ? { token: scopedToken }
          : {}),
      }))
  const store = open(
    state.storeRef,
    token !== undefined && token !== '' ? token : undefined,
  )
  try {
    const record = await store.getBuild(opts.build)
    if (record === null) {
      throw new Error(
        `no build "${opts.build}" in this store — run 'ab builds --all' or pass --store <ref>`,
      )
    }
    if (record.repo !== state.repo) {
      throw new Error(
        `build "${opts.build}" belongs to repository "${record.repo}", not "${state.repo}"`,
      )
    }
    const artifact = await store.getArtifact(opts.build, kind, rev)
    if (artifact === null) {
      const available = await store.listArtifacts(opts.build)
      const refs = available.map((meta) => `${meta.kind}@${meta.revision}`)
      throw new Error(
        `no "${kind}" artifact${rev !== undefined ? ` at rev ${rev}` : ''} in ` +
          `build "${opts.build}" — available refs: ${refs.join(', ') || '(none)'}`,
      )
    }

    const outputPath = resolve(opts.targetRepo, opts.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, artifact.content)
    return { artifact, outputPath }
  } finally {
    await store.close()
  }
}
