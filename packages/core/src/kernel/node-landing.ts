import { deferMixedVersion, MixedVersionDeferral } from './mixed-version'
import { inspectIntegrationStack } from './integration-stack'
import { integrationFailed } from './integration-state'
import type { BuildStore } from '../store/types'
import { readBuildFacts } from '../store/reduced-reads'
import type { Forge, AutoMergeDeferralReason } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { KERNEL, DISPATCHER } from '../events/envelope'
import { buildTrailers } from './build-identity'
import type { EventWrite } from '../events/catalog'

export interface NodeLandingDeps {
  store: BuildStore
  forge: Forge
  exec: Exec
  workspacePath: string
  slug: string
  node: string
  branch: string
  destination: string
  pr: number
  holder: string
  id: string
  stack?: { head: string; parent: string; cycle: string }
  eligible: () => Promise<boolean>
}
/** Cheap API-only proof, repeated under writer authority before publication. */
export async function preflightNodeLanding(
  forge: Forge,
  workspacePath: string,
  prNumber: number,
  branch: string,
  destination: string,
): Promise<AutoMergeDeferralReason | undefined> {
  const defer = (detail: string): AutoMergeDeferralReason => ({
    code: 'unproven-gate-state',
    detail,
  })
  if (!forge.rewrite || !forge.inspectLandingGate || !forge.inspectLandingPr)
    return defer(
      `Node merge requires rewrite, inspectLandingGate and inspectLandingPr capabilities; upgrade ${forge.name}. Native auto-merge is withheld to serialize node writes.`,
    )
  const pr = await forge.inspectLandingPr(workspacePath, prNumber)
  if (!pr.open || pr.base !== destination || pr.head !== branch)
    return defer('PR base/head disagrees with the frozen node target; human action required.')
  const gate = await forge.inspectLandingGate(destination)
  if (gate.kind !== 'proved-ungated')
    return {
      code: gate.kind === 'gated' ? 'gated-node-destination' : 'unproven-gate-state',
      detail: `${gate.reason}. Native auto-merge is withheld to serialize node writes; human action required.`,
    }
  return undefined
}
/** A successful guarded destination write is the landing. Provider PR state
 * is reconciled best-effort after its durable receipt, never used as proof. */
export async function landIntoNode(
  deps: NodeLandingDeps,
): Promise<AutoMergeDeferralReason | undefined> {
  const { store, forge, workspacePath, node } = deps
  const defer = (detail: string): AutoMergeDeferralReason => ({
    code: 'unproven-gate-state',
    detail,
  })
  if (!forge.rewrite || !forge.inspectLandingGate || !forge.inspectLandingPr)
    return defer(
      `Node merge requires rewrite, inspectLandingGate and inspectLandingPr capabilities; upgrade ${forge.name}. Native auto-merge is withheld to serialize node writes.`,
    )
  if (
    (await deferMixedVersion(store, deps.slug, KERNEL)) ||
    (await deferMixedVersion(store, node, KERNEL))
  )
    return undefined
  if (!(await store.claimNodeWriter(node, deps.holder, 60_000))) return undefined
  const authority = async () => {
    if (
      (await deferMixedVersion(store, deps.slug, KERNEL)) ||
      (await deferMixedVersion(store, node, KERNEL))
    )
      throw new MixedVersionDeferral()
    const state = (await readBuildFacts(store, node)).value.state
    if (
      state.status === 'aborted' ||
      state.status === 'done' ||
      state.status === 'paused' ||
      (state.status === 'blocked' && !integrationFailed(state)) ||
      state.prState === 'closed' ||
      state.prState === 'merged' ||
      state.pendingCommands.length ||
      state.nodeRestack?.parentRequest ||
      state.nodeRestack?.parentChange ||
      (state.integration?.intent && !state.integration.landing)
    )
      throw new Error('destination node no longer admits writes')
    if (!(await store.renewNodeWriter(node, deps.holder)))
      throw new Error('node merge writer lease lost')
    return state
  }
  let revision: number
  const append = async (event: EventWrite) => {
    await authority()
    const written = await store.appendIfCurrent(node, revision, event)
    if (!written) throw new Error('node merge reservation advanced')
    revision = written.seq
  }
  try {
    let state = await authority()
    revision = state.lastSeq
    let active = state.nodeRestack?.active
    if (active && (active.operation !== 'landing' || active.source !== deps.slug)) return undefined
    if (!active) {
      const preflight = await preflightNodeLanding(
        forge,
        workspacePath,
        deps.pr,
        deps.branch,
        deps.destination,
      )
      if (preflight) return preflight
      const cancellation = await forge.setAutoMerge(workspacePath, deps.pr, false)
      if (cancellation.kind !== 'applied')
        return defer('Native auto-merge cancellation is unconfirmed; no node write admitted.')
      if (!(await deps.eligible())) return undefined
      const pr = await forge.inspectLandingPr(workspacePath, deps.pr)
      if (!pr.open || pr.base !== deps.destination || pr.head !== deps.branch)
        return defer('PR base/head disagrees with the frozen node target; human action required.')
      const expected = await forge.rewrite.snapshot({
        workspacePath,
        branch: deps.destination,
        destinationRef: `refs/autobuild/reconcile/${deps.slug}/landing-destination`,
      })
      const candidate = await forge.rewrite.snapshot({
        workspacePath,
        branch: deps.branch,
        destinationRef: `refs/autobuild/reconcile/${deps.slug}/landing-source`,
      })
      if (candidate !== pr.headSha) return undefined
      const parents = await deps.exec(['git', 'show', '-s', '--format=%P', candidate], {
        cwd: workspacePath,
      })
      const message = await deps.exec(['git', 'show', '-s', '--format=%B', candidate], {
        cwd: workspacePath,
      })
      if (parents.exitCode !== 0 || message.exitCode !== 0)
        throw new Error('cannot inspect canonical node merge')
      if (
        deps.stack
          ? expected !== deps.stack.parent || candidate !== deps.stack.head
          : parents.stdout.trim() !== expected
      ) {
        const source = (await readBuildFacts(store, deps.slug)).value
        if (source.log.restack.target?.sha !== expected)
          await store.append(deps.slug, {
            actor: KERNEL,
            type: 'target.moved',
            payload: { branch: deps.destination, sha: expected },
          })
        return defer(
          'Leaf head is not one canonical change on the current node head; awaiting restack or human provenance review.',
        )
      }
      if (deps.stack) await inspectIntegrationStack(deps.exec, workspacePath, expected, candidate)
      if (
        !deps.stack &&
        JSON.stringify(buildTrailers(message.stdout)) !== JSON.stringify([deps.slug])
      )
        throw new Error('node merge requires exactly one canonical source identity')
      if (deps.stack) {
        const source = (await readBuildFacts(store, deps.slug)).value.state
        if (source.nodeRestack?.parentRequest || source.nodeRestack?.parentChange) return undefined
        if (!source.integration?.intent) {
          const intended = await store.appendIfCurrent(deps.slug, source.lastSeq, {
            actor: KERNEL,
            type: 'integration.landing-intended',
            payload: {
              id: deps.id,
              cycle: deps.stack.cycle,
              head: candidate,
              parent: expected,
              ...(source.landing?.decision
                ? { decisionSeq: source.landing.decision.seq }
                : { commandSeq: source.autoMerge.explicitCommandSeq! }),
              fenced: true,
              evidence: ['Destination node writer reservation and exact-parent fast-forward'],
            },
          })
          if (!intended) return undefined
        }
      }
      const archive = `refs/autobuild/archive/${node}/${expected}`
      await authority()
      await forge.rewrite.archive({ workspacePath, ref: archive, sha: expected })
      await authority()
      await forge.rewrite.archive({
        workspacePath,
        ref: `refs/autobuild/archive/${node}/${candidate}`,
        sha: candidate,
      })
      await append({
        actor: KERNEL,
        type: 'node.writer-reserved',
        payload: {
          id: deps.id,
          operation: 'landing',
          source: deps.slug,
          expected,
          parent: candidate,
          oldBase: state.nodeRestack?.contributionBase ?? state.nodeOpened!.sha,
          archive,
          changes: [],
          merges: [],
          upstreamBuilds: [],
        },
      })
      active = (await readBuildFacts(store, node)).value.state.nodeRestack!.active!
    }
    state = await authority()
    await forge.rewrite.archive({
      workspacePath,
      ref: `refs/autobuild/archive/${node}/${active.parent}`,
      sha: active.parent,
    })
    const abandon = async () =>
      append({
        actor: KERNEL,
        type: 'node.writer-settled',
        payload: { id: active!.id, outcome: 'abandoned' },
      })
    if (state.nodeRestack?.intent && !state.nodeRestack.rewritten) {
      const observed = await forge.rewrite.snapshot({
        workspacePath,
        branch: deps.destination,
        destinationRef: `refs/autobuild/reconcile/${deps.slug}/landing-readback`,
      })
      if (observed !== active.expected) {
        if (observed === active.parent) {
          await append({
            actor: KERNEL,
            type: 'node.rewritten',
            payload: { id: active.id, previous: active.expected, head: active.parent },
          })
          state = await authority()
        } else {
          await append({
            actor: KERNEL,
            type: 'node.writer-settled',
            payload: { id: active.id, outcome: 'contended', actual: observed },
          })
          return undefined
        }
      }
    }
    if (!state.nodeRestack?.rewritten) {
      const cancellation = await forge.setAutoMerge(workspacePath, deps.pr, false)
      if (cancellation.kind !== 'applied')
        return defer('Native auto-merge cancellation is unconfirmed; no node write admitted.')
      const pr = await forge.inspectLandingPr(workspacePath, deps.pr)
      if (
        !pr.open ||
        pr.base !== deps.destination ||
        pr.head !== deps.branch ||
        pr.headSha !== active.parent
      ) {
        await abandon()
        return defer('Reserved node merge no longer matches the PR; human action required.')
      }
      const gate = await forge.inspectLandingGate(deps.destination)
      if (gate.kind !== 'proved-ungated') {
        await abandon()
        return {
          code: gate.kind === 'gated' ? 'gated-node-destination' : 'unproven-gate-state',
          detail: `${gate.reason}. Native auto-merge is withheld to serialize node writes; human action required.`,
        }
      }
      if (!(await deps.eligible())) {
        await abandon()
        return undefined
      }
      if (!state.nodeRestack?.intent)
        await append({
          actor: KERNEL,
          type: 'node.publish-intended',
          payload: { id: active.id, head: active.parent },
        })
      await authority()
      const result = await forge.rewrite.replace({
        workspacePath,
        branch: deps.destination,
        expected: active.expected,
        sha: active.parent,
      })
      if (result.kind === 'lease-mismatch' && !result.rewritten) {
        await append({
          actor: KERNEL,
          type: 'node.writer-settled',
          payload: { id: active.id, outcome: 'contended', actual: result.actual },
        })
        if (deps.stack) {
          const intent = (await readBuildFacts(store, deps.slug)).value.state.integration?.intent
          if (intent)
            await store.append(deps.slug, {
              actor: KERNEL,
              type: 'integration.abandoned',
              payload: { id: intent.id, reason: 'Destination parent compare-and-swap contended' },
            })
        }
        if (result.actual)
          await store.append(deps.slug, {
            actor: KERNEL,
            type: 'target.moved',
            payload: { branch: deps.destination, sha: result.actual },
          })
        return undefined
      }
      await append({
        actor: KERNEL,
        type: 'node.rewritten',
        payload: { id: active.id, previous: active.expected, head: active.parent },
      })
    }
    const source = (await readBuildFacts(store, deps.slug)).value.state
    if (deps.stack && !source.integration?.landing)
      await store.append(deps.slug, {
        actor: DISPATCHER,
        type: 'integration.landed',
        payload: {
          operation: active.id,
          head: active.parent,
          landed: active.parent,
          provenance: 'kernel',
          verified: true,
          fenced: true,
        },
      })
    if (source.prState !== 'merged')
      await store.append(deps.slug, {
        actor: DISPATCHER,
        type: 'pr.merged',
        payload: { sha: active.parent, buildTrailerPresent: true },
      })
    await append({
      actor: KERNEL,
      type: 'node.writer-settled',
      payload: { id: active.id, outcome: 'completed' },
    })
    await acknowledgeNodeLanding(forge, workspacePath, deps.pr, active.parent)
    return undefined
  } finally {
    await store.releaseNodeWriter(node, deps.holder)
  }
}

/** Review acknowledgement cannot change, retry, or fail a proven landing. */
export async function acknowledgeNodeLanding(
  forge: Forge,
  workspacePath: string,
  number: number,
  sha: string,
): Promise<void> {
  try {
    const pr = await forge.getPrState(workspacePath, number)
    if (pr.state === 'open') {
      try {
        await forge.commentOnPr?.(
          workspacePath,
          number,
          `Merged by Autobuild at commit ${sha}. Closing the review after the guarded fast-forward.`,
        )
      } catch {
        /* Still attempt closure when the comment service is unavailable. */
      }
      await forge.closePr?.(workspacePath, number)
    }
  } catch {
    /* Provider acknowledgement never retries or fails the landing. */
  }
}

/** Terminal nodes stop admission but still settle already frozen effects before
 * cleanup. This never initiates a branch write. */
export async function settleClosedNode(deps: {
  store: BuildStore
  forge: Forge
  exec: Exec
  workspacePath: string
  slug: string
  branch: string
  holder: string
}): Promise<boolean> {
  const { store, slug, forge, workspacePath } = deps
  if (await deferMixedVersion(store, slug, KERNEL)) return false
  if (!(await store.claimNodeWriter(slug, deps.holder, 60_000))) return false
  const append = async (write: EventWrite) => {
    if (!(await store.renewNodeWriter(slug, deps.holder)))
      throw new Error('node cleanup writer lost')
    const state = (await readBuildFacts(store, slug)).value.state
    if (!(await store.appendIfCurrent(slug, state.lastSeq, write)))
      throw new Error('node cleanup reservation changed')
  }
  try {
    const node = (await readBuildFacts(store, slug)).value.state.nodeRestack
    const active = node?.active
    if (!active) return true
    let landed = !!node.rewritten
    if (active.operation === 'landing' && node.intent && !landed) {
      if (!forge.rewrite) return false
      await forge.rewrite.archive({
        workspacePath,
        ref: `refs/autobuild/archive/${slug}/${active.parent}`,
        sha: active.parent,
      })
      const actual = await forge.rewrite.snapshot({
        workspacePath,
        branch: deps.branch,
        destinationRef: `refs/autobuild/reconcile/${slug}/closed-readback`,
      })
      landed = actual === active.parent
      if (landed)
        await append({
          actor: KERNEL,
          type: 'node.rewritten',
          payload: { id: active.id, previous: active.expected, head: active.parent },
        })
    }
    if (active.operation === 'landing' && landed && active.source) {
      const source = (await readBuildFacts(store, active.source)).value.state
      if (source.prState !== 'merged')
        await store.append(active.source, {
          actor: DISPATCHER,
          type: 'pr.merged',
          payload: { sha: active.parent, buildTrailerPresent: true },
        })
    }
    await append({
      actor: KERNEL,
      type: 'node.writer-settled',
      payload: { id: active.id, outcome: landed ? 'completed' : 'abandoned' },
    })
    return true
  } finally {
    await store.releaseNodeWriter(slug, deps.holder)
  }
}
