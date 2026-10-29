import type { BuildStore } from '../store/types'
import type { Forge } from '../ports/types'
import type { EventWrite } from '../events/catalog'
import { readBuildFacts } from '../store/reduced-reads'
import { gitOid } from '../events/payloads'

export function assertTargetOid(sha: string): void {
  if (!gitOid.safeParse(sha).success) throw new Error('invalid target commit OID')
}

/** Admit only immutable forward destinations. CAS loss requires reclassification
 * against the winning accepted observation, never a blind append. Reads consume
 * reduced values only; idle polls read no event rows. */
export async function observeTarget(input: {
  store: BuildStore
  forge: Forge
  slug: string
  branch: string
  sha: string
  recordAccepted?: boolean
  enforceUsedBaseline?: boolean
  actor: EventWrite['actor']
}): Promise<'moved' | 'unchanged' | 'rejected' | 'cleared'> {
  const { store, forge, slug, branch, sha, actor } = input
  assertTargetOid(sha)
  for (;;) {
    const facts = await readBuildFacts(store, slug)
    const { state, log } = facts.value
    const restack = log.restack
    const node = state.nodeRestack
    const accepted = restack.target?.branch === branch ? restack.target.sha : undefined
    // Reparent acceptance establishes a new branch scope. Until its replay
    // settles the old parent's contribution boundary is not a baseline here.
    const reconcile = log.lastReconcileCompleted
    const leafBase =
      reconcile && reconcile.completedSeq > (restack.completedAt ?? 0)
        ? reconcile.baseSha
        : (restack.completed?.targetBase ?? restack.initialBase)
    const used =
      state.kind === 'node'
        ? node?.parentChange && node.parentReplay !== node.parentChange.id
          ? undefined
          : node?.contributionBase
        : leafBase
    const baselines = [...new Set([accepted, used].filter((s): s is string => !!s))]
    const rejected = restack.targetRewrite
    if (accepted === sha && !rejected && !input.enforceUsedBaseline) return 'unchanged'
    if (
      rejected?.branch === branch &&
      rejected.sha === sha &&
      baselines.includes(rejected.previousSha)
    )
      return 'rejected'
    let previousSha: string | undefined
    for (const baseline of baselines) {
      assertTargetOid(baseline)
      if (baseline === sha) continue
      if (!forge.isCommitAncestor) throw new Error('forge ancestry proof capability unavailable')
      if (!(await forge.isCommitAncestor(baseline, sha))) {
        previousSha = baseline
        break
      }
    }
    if (!previousSha && input.recordAccepted === false && !rejected) return 'unchanged'
    const write: EventWrite | undefined = previousSha
      ? { actor, type: 'target.rewritten', payload: { branch, previousSha, sha } }
      : accepted !== sha
        ? { actor, type: 'target.moved', payload: { branch, sha } }
        : rejected
          ? { actor, type: 'target.rewrite-cleared', payload: { branch, sha } }
          : undefined
    if (!write) return 'unchanged'
    if (!(await store.appendIfCurrent(slug, facts.cursor, write))) continue
    return previousSha ? 'rejected' : accepted === sha ? 'cleared' : 'moved'
  }
}
