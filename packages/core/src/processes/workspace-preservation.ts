import { DISPATCHER } from '../events/envelope'
import type { Forge, WorkspaceProvider } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { preserveGitCommits } from '../ports/workspace/commit-preservation'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'

export class WorkspaceFenceUnknown extends Error {}

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
    })
  } else {
    if (!deps.forge.rewrite) throw new Error('forge lacks immutable workspace commit archives')
    const base = await deps.forge.rewrite.snapshot({
      workspacePath: handle.path,
      branch: handle.branch,
      destinationRef: `refs/autobuild/reconcile/${deps.slug}/preservation`,
    })
    preserved = {
      outcome: 'preserved',
      heads: await preserveGitCommits({
        exec: deps.exec,
        workspacePath: handle.path,
        branch: handle.branch,
        slug: deps.slug,
        base,
        candidates,
        archive: deps.forge.rewrite.archive,
      }),
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
            reason: `${deps.reason}: source environment is absent; additional unpublished SHAs could not be inspected`,
          },
        }
  if (!(await deps.store.appendIfCurrent(deps.slug, current.cursor, write)))
    throw new Error('workspace changed during commit preservation; retry cleanup')
}
