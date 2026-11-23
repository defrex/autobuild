import { DISPATCHER } from '../events/envelope'
import { remoteBranchHead } from '../ports/forge/git-rewrite'
import type { Forge, WorkspacePreservationHead, WorkspaceProvider } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { preserveGitCommits } from '../ports/workspace/commit-preservation'
import { restoreRetainedHead, retainPreservedCopy } from '../kernel/history-retention'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'

export class WorkspaceFenceUnknown extends Error {}

/** Key-order-independent identity of a preserved head. */
const headIdentity = (head: WorkspacePreservationHead) => [
  head.sha,
  head.role,
  head.commits,
  head.remoteRef ?? null,
  head.storeBase ?? null,
]

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
  const local = deps.forge.name === 'local-git'
  const rewriteCapability = deps.forge.kernelRewrite ?? deps.forge.rewrite
  // Strict store fallback for heads the forge refused to archive; it runs on
  // the trusted transport the caller hands over, never inside the guest.
  const context = (exec: Exec, workspacePath: string, exclude: string) => ({
    store: deps.store,
    slug: deps.slug,
    exec,
    workspacePath,
    exclude,
    local,
    branch: handle.branch,
    targetBranch: current.value.state.baseBranch,
    archive:
      rewriteCapability?.archive ??
      (async () => {
        throw new Error('archive unavailable during store retention')
      }),
  })
  const retain = (input: { exec: Exec; workspacePath: string; sha: string; base: string }) =>
    retainPreservedCopy(context(input.exec, input.workspacePath, input.base), input.sha)
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
      retain,
    })
  } else {
    const rewrite = rewriteCapability
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
    const exec = deps.forge.kernelExec ?? deps.exec
    preserved = {
      outcome: 'preserved',
      heads: await preserveGitCommits({
        exec,
        workspacePath: handle.path,
        branch: handle.branch,
        slug: deps.slug,
        base,
        candidates,
        archive: rewrite.archive,
        replaced: current.value.replacedHeads,
        local,
        neverExecuted,
        retain,
        restore: (sha) => restoreRetainedHead(context(exec, handle.path, base), sha),
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
  // Forge-only receipts keep their original type, so accepting forges see no
  // change; any store-kept head makes the receipt `commits-retained`.
  const preservedType =
    preserved.outcome === 'preserved' &&
    preserved.heads.some((head) => head.storeBase !== undefined)
      ? ('workspace.commits-retained' as const)
      : ('workspace.commits-preserved' as const)
  if (
    preserved.outcome === 'preserved' &&
    current.value.workspacePreservation?.type === preservedType &&
    prior?.workspace === source.seq &&
    prior.execution === executionSeq &&
    JSON.stringify(prior.heads.map(headIdentity)) ===
      JSON.stringify(preserved.heads.map(headIdentity))
  )
    return
  const write =
    preserved.outcome === 'preserved'
      ? preservedType === 'workspace.commits-retained'
        ? {
            actor: DISPATCHER,
            type: 'workspace.commits-retained' as const,
            payload: { ...metadata, heads: preserved.heads },
          }
        : {
            actor: DISPATCHER,
            type: 'workspace.commits-preserved' as const,
            payload: {
              ...metadata,
              heads: preserved.heads.map(({ sha, remoteRef, role, commits }) => ({
                sha,
                remoteRef: remoteRef!,
                role,
                commits,
              })),
            },
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
