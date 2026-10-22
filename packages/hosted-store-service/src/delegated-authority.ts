import { delegationFactKey } from '@defrex/autobuild/remote-store'
import type { BuildDelegationFacts, HarvestDelegationFacts } from '@defrex/autobuild/remote-store'
import {
  mintToken,
  delegateCredentialBodySchema,
  type DelegatedTokenScope,
  type RepositoryEvent,
} from '@defrex/autobuild/remote-store'
import type { AbEvent, BuildRecord, BuildStore } from '@defrex/autobuild/plugin-sdk'
import { reduceBuild } from '@defrex/autobuild/remote-store'
import { MachineAuthError, requireProject, type MachineAuth } from './machine-auth'

export const DELEGATION_TERMINAL_GRACE_MS = 60_000
export type Delegation = DelegatedTokenScope['delegation']

/** Read authoritative facts every time. No lease expiry or parent credential
 * expiry can end a surviving execution; a durable ending cannot be undone. */
export async function delegationActive(
  store: BuildStore,
  claims: Delegation,
  now: Date,
): Promise<boolean> {
  const build = claims.kind.startsWith('build') ? await store.getBuild(claims.id) : null
  if (claims.kind.startsWith('build') && build?.repo !== claims.repo) return false
  const facts = await delegationFacts(store, claims)
  return evaluateDelegationFacts(claims, facts, now)
}

async function delegationFacts(
  store: BuildStore,
  target: { kind: string; id: string; repo: string },
) {
  const build = target.kind.startsWith('build')
  const answer = await store.getReducerValue(
    build ? { kind: 'build', slug: target.id } : { kind: 'repo', repo: target.repo },
    { reducer: build ? 'buildDelegation' : 'harvestDelegation' },
  )
  return answer.value as unknown as BuildDelegationFacts | HarvestDelegationFacts
}
export function evaluateDelegationFacts(
  claims: Delegation,
  facts: BuildDelegationFacts | HarvestDelegationFacts,
  now: Date,
): boolean {
  if (claims.anchor < 1 || claims.anchor > facts.lastSeq) return false
  let endings: string[]
  if ('terminals' in facts) {
    const session = claims.session ? facts.sessions[delegationFactKey(claims.session)] : undefined
    if (claims.session && !session?.starts.includes(claims.anchor)) return false
    endings = [...facts.terminals, ...(session?.endings ?? [])]
      .filter((event) => event.seq >= claims.anchor)
      .map((event) => event.at)
    if (facts.terminals.length > 0 && endings.length === 0) return false
  } else {
    const authorized =
      facts.authorizations[delegationFactKey(claims.id)]?.[delegationFactKey(claims.execution!)]
    if (!facts.runs[delegationFactKey(claims.id)] || !authorized) return false
    if (
      claims.kind === 'harvest-runner' &&
      (claims.anchor !== authorized.seq || claims.leaseHolder !== authorized.leaseHolder)
    )
      return false
    const session = claims.session
      ? facts.sessions[delegationFactKey(claims.id)]?.[delegationFactKey(claims.session)]
      : undefined
    if (claims.session && (!session?.starts.includes(claims.anchor) || session.suspended))
      return false
    endings = [
      ...(facts.releases[delegationFactKey(claims.execution!)] ?? []),
      ...[...(facts.endings[delegationFactKey(claims.id)] ?? []), ...(session?.endings ?? [])]
        .filter((event) => event.seq >= authorized.seq)
        .map((event) => event.at),
    ]
  }
  return endings.every(
    (at) =>
      Number.isFinite(Date.parse(at)) &&
      now.getTime() < Date.parse(at) + DELEGATION_TERMINAL_GRACE_MS,
  )
}

/** Pure policy over durable facts, shared by issuance and every authentication. */
export function evaluateDelegationLifecycle(
  claims: Delegation,
  lifecycle: {
    build?: BuildRecord | null
    buildEvents?: AbEvent[]
    repositoryEvents?: RepositoryEvent[]
  },
  now: Date,
): boolean {
  const endings: string[] = []
  if (claims.kind.startsWith('build')) {
    if (lifecycle.build?.repo !== claims.repo) return false
    const events = lifecycle.buildEvents ?? []
    if (!events.some((event) => event.seq === claims.anchor)) return false
    const state = reduceBuild(events)
    if (
      claims.session &&
      !events.some(
        (event) =>
          event.type === 'session.started' &&
          event.payload.session === claims.session &&
          event.seq === claims.anchor,
      )
    )
      return false
    for (const event of events) {
      if (event.seq < claims.anchor) continue
      if (
        event.type === 'build.completed' ||
        event.type === 'build.aborted' ||
        (event.type === 'session.ended' && event.payload.session === claims.session)
      )
        endings.push(event.ts)
    }
    if ((state.status === 'done' || state.status === 'aborted') && endings.length === 0)
      return false
  } else {
    const events = lifecycle.repositoryEvents ?? []
    if (
      claims.session &&
      events.some(
        (event) =>
          event.type === 'harvest.session.suspended' &&
          event.payload.run === claims.id &&
          event.payload.session === claims.session,
      )
    )
      return false
    const run = events.some(
      (event) => event.type === 'harvest.started' && event.payload.run === claims.id,
    )
    const authorized = events.find(
      (event) =>
        event.type === 'harvest.execution.authorized' &&
        event.payload.execution === claims.execution &&
        event.payload.run === claims.id,
    )
    if (!run || !authorized || !events.some((event) => event.seq === claims.anchor)) return false
    if (authorized.type !== 'harvest.execution.authorized') return false
    if (
      claims.kind === 'harvest-runner' &&
      (claims.anchor !== authorized.seq || claims.leaseHolder !== authorized.payload.leaseHolder)
    )
      return false
    for (const event of events) {
      if (
        (event.type === 'harvest.execution.released' || event.type === 'harvest.execution.ended') &&
        event.payload.execution === claims.execution
      )
        endings.push(event.ts)
    }
    if (
      claims.session &&
      !events.some(
        (event) =>
          event.type === 'harvest.session.started' &&
          event.payload.run === claims.id &&
          event.payload.session === claims.session &&
          event.seq === claims.anchor,
      )
    )
      return false
    for (const event of events) {
      if (
        event.seq < authorized.seq ||
        !('run' in event.payload) ||
        event.payload.run !== claims.id
      )
        continue
      if (
        event.type === 'harvest.completed' ||
        event.type === 'harvest.escalated' ||
        (event.type === 'harvest.failed' && !event.payload.willRetry) ||
        event.type === 'harvest.recovery-exhausted' ||
        ((event.type === 'harvest.session.ended' || event.type === 'harvest.session.suspended') &&
          event.payload.session === claims.session)
      )
        endings.push(event.ts)
    }
  }
  return endings.every(
    (at) =>
      Number.isFinite(Date.parse(at)) &&
      now.getTime() < Date.parse(at) + DELEGATION_TERMINAL_GRACE_MS,
  )
}

export function createDelegationHandler(options: {
  store: BuildStore
  auth: MachineAuth
  secret: string
  clock?: () => Date
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const principal = await options.auth.authenticate(request)
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ kind: 'validation', error: 'invalid JSON' }, { status: 400 })
      }
      const parsed = delegateCredentialBodySchema.safeParse(body)
      if (!parsed.success)
        return Response.json(
          { kind: 'validation', error: 'invalid delegation target' },
          { status: 400 },
        )
      const target = parsed.data
      const build = target.kind.startsWith('build') ? await options.store.getBuild(target.id) : null
      const repo = build?.repo ?? ('repo' in target ? target.repo : undefined)
      if (!repo) throw new MachineAuthError(404, 'resource unavailable')
      requireProject(principal, repo)
      if (principal.kind === 'internal')
        throw new MachineAuthError(403, 'operator authority cannot delegate machine credentials')
      if (principal.kind === 'delegated') {
        const parent = principal.delegation
        if (
          !parent.kind.endsWith('-runner') ||
          !target.kind.endsWith('-phase') ||
          parent.id !== target.id ||
          parent.kind.split('-')[0] !== target.kind.split('-')[0]
        )
          throw new MachineAuthError(403, 'delegation cannot widen authority')
      }
      if (
        'leaseHolder' in target &&
        (await options.store.getRepo(repo))?.lease?.holder !== target.leaseHolder
      )
        throw new MachineAuthError(403, 'harvest holder does not own the repository lease')
      const execution =
        'execution' in target
          ? target.execution
          : principal.kind === 'delegated'
            ? principal.delegation.execution
            : undefined
      const facts = await delegationFacts(options.store, { kind: target.kind, id: target.id, repo })
      const anchor =
        'session' in target
          ? ('terminals' in facts
              ? facts.sessions[delegationFactKey(target.session)]
              : facts.sessions[delegationFactKey(target.id)]?.[delegationFactKey(target.session)]
            )?.starts[0]
          : 'terminals' in facts
            ? facts.lastSeq || undefined
            : facts.authorizations[delegationFactKey(target.id)]?.[delegationFactKey(execution!)]
                ?.seq
      if (
        principal.kind === 'delegated' &&
        anchor !== undefined &&
        anchor < principal.delegation.anchor
      )
        throw new MachineAuthError(403, 'session predates runner authority')
      if (anchor === undefined) throw new MachineAuthError(404, 'lifecycle binding unavailable')
      const delegation: Delegation = {
        repo,
        kind: target.kind,
        id: target.id,
        anchor,
        ...(execution ? { execution } : {}),
        ...('session' in target ? { session: target.session } : {}),
        ...('leaseHolder' in target ? { leaseHolder: target.leaseHolder } : {}),
      }
      if (
        !(await delegationActive(
          options.store,
          delegation,
          (options.clock ?? (() => new Date()))(),
        ))
      )
        throw new MachineAuthError(403, 'lifecycle binding ended')
      return Response.json({ token: mintToken(options.secret, { version: 2, delegation }) })
    } catch (error) {
      if (error instanceof MachineAuthError)
        return Response.json({ kind: 'auth', error: error.message }, { status: error.status })
      throw error
    }
  }
}
