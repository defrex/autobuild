import { deferMixedVersion, MixedVersionDeferral } from './mixed-version'
import { snapshotParent } from './snapshot-parent'
import { buildTrailers } from './build-identity'
import { KERNEL, DISPATCHER } from '../events/envelope'
import type { Forge } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildStore } from '../store/types'
import { readBuildFacts } from '../store/reduced-reads'
import { inspectIntegrationStack } from './integration-stack'
import { acknowledgeNodeLanding } from './node-landing'

export interface IntegrationLandingDeps {
  store: BuildStore
  forge: Forge
  exec: Exec
  workspacePath: string
  slug: string
  branch: string
  destination: string
  pr: number
  holder: string
  id: string
  commandSeq?: number
  decisionSeq?: number
  head: string
  parent: string
  cycle: string
  eligible: () => Promise<boolean>
}
/** The source-owned reservation protects root publication across lease loss. */
export async function landIntegrationRoot(deps: IntegrationLandingDeps): Promise<void> {
  const { store, forge, slug, workspacePath, exec } = deps
  if (await deferMixedVersion(store, slug, KERNEL)) return
  if (!forge.rewrite || !forge.inspectLandingPr) return
  if (!(await store.claimNodeWriter(slug, deps.holder, 60_000))) return
  const authority = async () => {
    if (await deferMixedVersion(store, slug, KERNEL)) throw new MixedVersionDeferral()
    if (!(await store.renewNodeWriter(slug, deps.holder)))
      throw new Error('integration writer lease lost')
  }
  try {
    let state = (await readBuildFacts(store, slug)).value.state
    if (
      state.integration?.landing ||
      state.nodeRestack?.parentRequest ||
      state.nodeRestack?.parentChange
    )
      return
    const existing = state.integration?.intent
    let landed: string | undefined
    if (existing) {
      // Readback precedes controls: a completed write must survive revocation.
      const pr = await forge.getPrState(workspacePath, deps.pr)
      if (pr.state === 'merged' && pr.headSha === existing.head) landed = pr.sha
      if (forge.name === 'local-git') {
        const actual = await snapshotParent(
          deps,
          deps.destination,
          `refs/autobuild/reconcile/${slug}/readback`,
        )
        if (actual === existing.head) landed = existing.head
      }
    }
    const abandon = async (reason: string) => {
      const pending = (await readBuildFacts(store, slug)).value.state.integration?.intent
      if (pending)
        await store.append(slug, {
          actor: KERNEL,
          type: 'integration.abandoned',
          payload: { id: pending.id, reason },
        })
    }
    if (!landed) {
      if (!(await deps.eligible())) {
        await abandon('Eligibility changed before publication')
        return
      }
      const cancelled = await forge.setAutoMerge(workspacePath, deps.pr, false)
      if (cancelled.kind !== 'applied') return
      const pr = await forge.inspectLandingPr(workspacePath, deps.pr)
      if (
        !pr.open ||
        pr.base !== deps.destination ||
        pr.head !== deps.branch ||
        pr.headSha !== deps.head
      )
        return
      const parent = await snapshotParent(
        deps,
        deps.destination,
        `refs/autobuild/reconcile/${slug}/parent`,
      )
      const head = await forge.rewrite.snapshot({
        workspacePath,
        branch: deps.branch,
        destinationRef: `refs/autobuild/reconcile/${slug}/head`,
      })
      if (parent !== deps.parent || head !== deps.head) {
        await abandon('Parent or head moved')
        return
      }
      await inspectIntegrationStack(exec, workspacePath, parent, head)
      const local = forge.name === 'local-git'
      if (!local && !forge.mergeLinearStack) return // Never substitute squash.
      const gate = local ? await forge.inspectLandingGate?.(deps.destination) : undefined
      if (local && (!forge.rewrite.fastForward || gate?.kind !== 'proved-ungated')) return
      const freshness = local
        ? { fenced: true, evidence: ['Exact parent compare-and-swap fast-forward'] }
        : ((await forge.inspectMergeFreshness?.(deps.destination)) ?? {
            fenced: false,
            evidence: ['Freshness enforcement unavailable'],
          })
      await authority()
      await forge.rewrite.archive({
        workspacePath,
        ref: `refs/autobuild/archive/${slug}/${head}`,
        sha: head,
      })
      if (!existing) {
        await store.append(slug, {
          actor: KERNEL,
          type: 'integration.landing-intended',
          payload: {
            id: deps.id,
            cycle: deps.cycle,
            head,
            parent,
            ...(deps.commandSeq === undefined ? {} : { commandSeq: deps.commandSeq }),
            ...(deps.decisionSeq === undefined ? {} : { decisionSeq: deps.decisionSeq }),
            ...freshness,
          },
        })
      } else if (
        existing.head !== head ||
        existing.parent !== parent ||
        existing.commandSeq !== deps.commandSeq
      )
        return
      if (!(await deps.eligible())) {
        await abandon('Eligibility changed before publication')
        return
      }
      await authority()
      // This is the final external read before the merge request. GitHub's
      // endpoint fences the head only; its remaining race is audited below.
      const current = await snapshotParent(
        deps,
        deps.destination,
        `refs/autobuild/reconcile/${slug}/fresh`,
      )
      if (current !== parent) {
        const pending = (await readBuildFacts(store, slug)).value.state.integration?.intent
        if (pending)
          await store.append(slug, {
            actor: KERNEL,
            type: 'integration.abandoned',
            payload: { id: pending.id, reason: 'Parent moved before publication' },
          })
        return
      }
      if (local) {
        const result = await forge.rewrite.fastForward!({
          workspacePath,
          branch: deps.destination,
          expected: parent,
          sha: head,
        })
        if (result.kind !== 'published') return
        landed = head
      } else {
        landed = await forge.mergeLinearStack!(workspacePath, deps.pr, head)
      }
    }
    await authority()
    state = (await readBuildFacts(store, slug)).value.state
    const intent = state.integration!.intent!
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'integration.landed',
      payload: {
        operation: intent.id,
        head: intent.head,
        landed,
        provenance: 'kernel',
        verified: true,
        fenced: intent.fenced,
      },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'pr.merged',
      payload: { sha: landed, buildTrailerPresent: true },
    })
    await acknowledgeNodeLanding(forge, workspacePath, deps.pr, landed)
  } finally {
    await store.releaseNodeWriter(slug, deps.holder)
  }
}

/** Audit immutable merge-result commits, including after build completion. */
export async function auditIntegrationLanding(
  deps: Pick<IntegrationLandingDeps, 'store' | 'forge' | 'exec' | 'workspacePath' | 'slug' | 'id'>,
): Promise<void> {
  if (await deferMixedVersion(deps.store, deps.slug, KERNEL)) return
  const state = (await readBuildFacts(deps.store, deps.slug)).value.state
  const landing = state.integration?.landing
  if (!landing?.operation || state.integration?.audit || !deps.forge.rewrite) return
  const trees: string[] = []
  for (const sha of [landing.head, landing.landed]) {
    const present = await deps.exec(['git', 'cat-file', '-e', `${sha}^{commit}`], {
      cwd: deps.workspacePath,
    })
    if (present.exitCode !== 0) {
      const fetched = await deps.exec(['git', 'fetch', '--no-tags', 'origin', sha], {
        cwd: deps.workspacePath,
      })
      if (fetched.exitCode !== 0) throw new Error('integration audit commit unavailable')
    }
    const tree = await deps.exec(['git', 'rev-parse', `${sha}^{tree}`], { cwd: deps.workspacePath })
    if (tree.exitCode !== 0) throw new Error('integration merge tree audit pending')
    trees.push(tree.stdout.trim())
  }
  const intent = state.integration?.intent
  const identities = intent
    ? await inspectIntegrationStack(deps.exec, deps.workspacePath, intent.parent, landing.head)
    : []
  const messages = intent
    ? await deps.exec(
        ['git', 'log', '--format=%B%x00', `${intent.parent}..${landing.landed}`, '--'],
        { cwd: deps.workspacePath },
      )
    : undefined
  if (messages && messages.exitCode !== 0) throw new Error('merge identity audit pending')
  const landedIdentities = messages
    ? messages.stdout.split('\0').flatMap((message) => buildTrailers(message))
    : []
  const missing = identities.filter(
    (identity) => landedIdentities.filter((value) => value === identity).length !== 1,
  )
  if (trees[0] !== trees[1] || missing.length) {
    const id = `integration-audit-${landing.operation}`
    if (![...state.openEscalations, ...state.answeredEscalations].some((item) => item.id === id))
      await deps.store.append(deps.slug, {
        actor: KERNEL,
        type: 'escalation.raised',
        payload: {
          id,
          phase: 'verify:integration',
          source: 'agent',
          question: `Integration result requires attention: verified ${landing.head} (${trees[0]}), merged ${landing.landed} (${trees[1]}). Missing or duplicate identities: ${missing.join(', ') || 'none'}. The shared parent has not been rewritten.`,
        },
      })
  }
  await deps.store.append(deps.slug, {
    actor: KERNEL,
    type: 'integration.audited',
    payload: {
      operation: landing.operation,
      verifiedTree: trees[0]!,
      landedTree: trees[1]!,
      identities,
    },
  })
}
