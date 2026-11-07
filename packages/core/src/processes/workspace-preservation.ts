import { DISPATCHER } from '../events/envelope'
import { remoteBranchHead } from '../ports/forge/git-rewrite'
import type { Forge, WorkspacePreservationHead, WorkspaceProvider } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { preserveGitCommits } from '../ports/workspace/commit-preservation'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'

export class WorkspaceFenceUnknown extends Error {}

/** Provider-independent exact supersession: a preserved branch head that a
 * recorded rewrite replaced keeps its objects as a producer and never moves
 * the branch. Ancestor coverage stays with the providers' Git checks. */
export function supersedeRestorationHeads(
  heads: WorkspacePreservationHead[] | undefined,
  replaced: readonly string[],
): { restoration: WorkspacePreservationHead[] | undefined; superseded: string[] } {
  const superseded: string[] = []
  const restoration = heads?.map((head) => {
    if (head.role !== 'branch' || !replaced.includes(head.sha)) return head
    superseded.push(head.sha)
    return { ...head, role: 'producer' as const }
  })
  return { restoration, superseded }
}

/** Every caller holds the build's cleanup boundary. A fence is revalidated on
 * every invocation, including restart: durable receipts cannot stop new code. */
export async function preserveWorkspaceBeforeRelease(deps: {
  store: BuildStore
  slug: string
  owner: WorkspaceProvider
  forge: Forge
  exec: Exec
  reason: string
  now?: Date
}): Promise<void> {
  let current = await readBuildFacts(deps.store, deps.slug)
  const source = current.value.latestWorkspace
  if (!source || current.value.workspace === null) return
  const handle = { ...source.payload, path: source.payload.path ?? source.payload.ref }
  const execution = current.value.state.executions.at(-1)
  const executionSeq = execution?.workspaceRef === source.payload.ref ? execution.seq : 0
  // Any execution on this ref, not only the latest, keeps a reused ref strict.
  const neverExecuted = !current.value.state.executions.some(
    (started) => started.workspaceRef === source.payload.ref,
  )
  const record = await deps.store.getBuild(deps.slug)
  if (
    current.value.open !== null &&
    record?.lease &&
    new Date(record.lease.expiresAt).getTime() > (deps.now ?? new Date()).getTime()
  )
    throw new Error('workspace preservation refused while execution lease is live')
  if (!deps.owner.recovery && current.value.open !== null)
    throw new WorkspaceFenceUnknown('local execution teardown has not been recorded')
  const outcome = deps.owner.recovery
    ? await deps.owner.recovery.fence?.(handle)
    : { outcome: 'confirmed' as const }
  if (!outcome || outcome.outcome === 'unknown')
    throw new WorkspaceFenceUnknown(
      `workspace fence is unknown: ${outcome && 'error' in outcome ? outcome.error : 'provider lacks non-destructive fencing'}`,
    )
  const fence = current.value.workspaceFence?.payload
  if (
    fence?.workspace !== source.seq ||
    fence.execution !== executionSeq ||
    fence.outcome !== outcome.outcome
  ) {
    if (
      !(await deps.store.appendIfCurrent(deps.slug, current.cursor, {
        actor: DISPATCHER,
        type: 'workspace.fenced',
        payload: {
          workspace: source.seq,
          execution: executionSeq,
          ref: handle.ref,
          outcome: outcome.outcome,
        },
      }))
    )
      throw new Error('workspace changed during fencing; retry cleanup')
    current = await readBuildFacts(deps.store, deps.slug)
  }
  const prior = current.value.workspacePreservation?.payload
  const loss = current.value.workspaceLoss?.payload
  if (
    outcome.outcome === 'absent' &&
    loss?.workspace === source.seq &&
    loss.execution === executionSeq
  )
    return
  const request = current.value.publication.latestUncompletedRequest()
  const candidates = [
    ...new Set([
      ...(request && !current.value.publication.lostRecorded(request) ? [request.payload.sha] : []),
      ...(prior?.heads.map((head) => head.sha) ?? []),
    ]),
  ]
  const metadata = {
    workspace: source.seq,
    execution: executionSeq,
    ref: handle.ref,
    branch: handle.branch,
    phase: current.value.state.phase ?? 'implement',
    round: current.value.state.round ?? 1,
  }
  let preserved:
    | { outcome: 'preserved'; heads: import('../ports/types').WorkspacePreservationHead[] }
    | { outcome: 'absent' }
  if (outcome.outcome === 'absent') preserved = { outcome: 'absent' }
  else if (deps.owner.preservation || deps.owner.publication) {
    const preserve = deps.owner.preservation ?? deps.owner.publication?.preserve
    if (!preserve) throw new Error('remote provider lacks trusted commit preservation')
    preserved = await preserve({
      ref: handle.ref,
      slug: deps.slug,
      branch: handle.branch,
      base: source.payload.base.sha,
      candidates,
      replaced: current.value.replacedHeads,
      neverExecuted,
    })
  } else {
    const rewrite = deps.forge.kernelRewrite ?? deps.forge.rewrite
    if (!rewrite) throw new Error('forge lacks immutable workspace commit archives')
    let base: string
    try {
      base = await rewrite.snapshot({
        workspacePath: handle.path,
        branch: handle.branch,
        destinationRef: `refs/autobuild/reconcile/${deps.slug}/preservation`,
      })
    } catch (error) {
      // A never-published branch compares against its recorded base; any other
      // snapshot failure, or an unreadable remote, keeps the workspace intact.
      const remote = await remoteBranchHead(
        deps.forge.kernelExec ?? deps.exec,
        handle.path,
        handle.branch,
      ).catch(() => undefined)
      if (remote !== null) throw error
      base = source.payload.base.sha
    }
    preserved = {
      outcome: 'preserved',
      heads: await preserveGitCommits({
        exec: deps.forge.kernelExec ?? deps.exec,
        workspacePath: handle.path,
        branch: handle.branch,
        slug: deps.slug,
        base,
        candidates,
        archive: rewrite.archive,
        replaced: current.value.replacedHeads,
        local: deps.forge.name === 'local-git',
        neverExecuted,
      }),
    }
  }
  // A never-executed environment holds no unpublished work, but the latest
  // receipt drives restoration: earlier archived heads it could not see stay
  // restorable under their immutable refs.
  if (neverExecuted && preserved.outcome === 'preserved' && prior) {
    const found = new Set(preserved.heads.map((head) => head.sha))
    preserved = {
      outcome: 'preserved',
      heads: [...preserved.heads, ...prior.heads.filter((head) => !found.has(head.sha))],
    }
  }
  if (
    preserved.outcome === 'preserved' &&
    prior?.workspace === source.seq &&
    prior.execution === executionSeq &&
    JSON.stringify(prior.heads) === JSON.stringify(preserved.heads)
  )
    return
  const write =
    preserved.outcome === 'preserved'
      ? {
          actor: DISPATCHER,
          type: 'workspace.commits-preserved' as const,
          payload: { ...metadata, heads: preserved.heads },
        }
      : {
          actor: DISPATCHER,
          type: 'workspace.commits-lost' as const,
          payload: {
            ...metadata,
            shas: [...new Set([...candidates, ...(request ? [request.payload.sha] : [])])].filter(
              (sha) => !prior?.heads.some((head) => head.sha === sha),
            ),
            inventory: 'additional-shas-unavailable' as const,
            reason: `${deps.reason}: source environment or checkout is absent; additional unpublished SHAs could not be inspected`,
          },
        }
  if (!(await deps.store.appendIfCurrent(deps.slug, current.cursor, write)))
    throw new Error('workspace changed during commit preservation; retry cleanup')
}
