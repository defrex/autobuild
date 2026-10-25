import { createHash } from 'node:crypto'
import { BUILD_OWNED_CONFIG_PATHS, composeBuildConfig } from '../config/live'
import type { PipelineSource } from '../config/pipeline-source'
import type { Config } from '../config/schema'
import { KERNEL } from '../events/envelope'
import type { BuildState } from '../kernel/reducer'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildScopedStore } from '../store/types'
import { effectiveBuildConfigContent, parseEffectiveBuildConfig } from './build-execution-state'

export type VerifyPipelineReader = () => Promise<PipelineSource & { head: string }>
export function buildConfigIdentity(config: Config): string {
  return createHash('sha256')
    .update(JSON.stringify(BUILD_OWNED_CONFIG_PATHS.map((path) => config[path])))
    .digest('hex')
}

/** A capture owns its immutable artifact revision; latest-artifact races cannot retarget it. */
export async function capturedBuildConfig(
  store: Pick<BuildScopedStore, 'getArtifact'>,
  slug: string,
  state: BuildState,
  deployment: Config,
): Promise<Config> {
  const pin = state.verify.configPin
  if (!pin) return deployment
  const artifact = await store.getArtifact(slug, pin.artifact.kind, pin.artifact.rev)
  if (!artifact)
    throw new Error(`missing captured verify config ${pin.artifact.kind}@${pin.artifact.rev}`)
  return composeBuildConfig(parseEffectiveBuildConfig(artifact), deployment)
}

/** Called only after a whole stage settles and workspace mutation completes. */
export async function refreshVerifyCycle(input: {
  store: BuildScopedStore
  slug: string
  state: BuildState
  deployment: Config
  read: VerifyPipelineReader
  exec: Exec
  workspacePath: string
  /** A waiting leaf runs no further verifier; clean replay may retain its receipts. */
  retainCompletedVerification?: boolean
}): Promise<boolean> {
  const { store, slug, state, deployment } = input
  const observed = await input.read()
  const identity = buildConfigIdentity(observed.config)
  const pin = state.verify.configPin
  if (pin && pin.cycle === state.verify.cycleSince) {
    // Ancestry gates execution, not historical evidence. A clean waiting-leaf
    // replay replaces the canonical commit without changing the verified work.
    // Content changes still supersede, and a future cycle captures before work.
    if (input.retainCompletedVerification && identity === pin.identity) return false
    let ancestral = true
    if (pin.source.commit) {
      const result = await input.exec(
        ['git', 'merge-base', '--is-ancestor', pin.source.commit, observed.head],
        { cwd: input.workspacePath },
      )
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw new Error(`cannot establish verify pin ancestry: ${result.stderr}`)
      ancestral = result.exitCode === 0
    }
    if (identity === pin.identity && ancestral) return false
    await store.appendIfCurrent(slug, state.lastSeq, {
      actor: KERNEL,
      type: 'verify.config-superseded',
      payload: { captureSeq: pin.seq, head: observed.head, identity },
    })
    return true
  }
  const config = composeBuildConfig(observed.config, deployment)
  const artifact = await store.putArtifact(slug, {
    kind: 'verify-cycle-config',
    content: effectiveBuildConfigContent(config),
    metadata: { pipelineSource: observed.meta, cycle: state.verify.cycleSince },
  })
  // Publishing an artifact is not a cycle transition. Only the capture fact
  // makes these bytes authoritative; keep the mutable launch/reload artifact
  // untouched so a crash before this append cannot expose an uncommitted pin.
  await store.appendIfCurrent(slug, state.lastSeq, {
    actor: KERNEL,
    type: 'verify.config-captured',
    payload: {
      cycle: state.lastSeq + 1,
      artifact: { kind: artifact.kind, rev: artifact.revision },
      head: observed.head,
      identity,
      source:
        observed.meta.ref === 'worktree-dirty'
          ? { ref: 'worktree-dirty' }
          : { ref: 'branch-head', commit: observed.head },
    },
  })
  return true
}
