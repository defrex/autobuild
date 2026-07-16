/**
 * `ab artifact put|get` (SPEC §8.2): versioned artifact deposit and fetch.
 * Own-build only by construction — the store handle is the build's, and a
 * remote store's token is scoped to build+session (D8), so an agent
 * physically cannot read or write another build's artifacts.
 */
import type { Artifact, ArtifactMeta, BuildStore } from '../store/types'
import type { CliEnv } from './env'

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
  const content = await file.text()
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
