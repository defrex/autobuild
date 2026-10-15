import {
  mintToken,
  delegateCredentialBodySchema,
  type DelegatedTokenScope,
  type RepositoryEvent,
} from '@defrex/autobuild/remote-store'
import type { AbEvent, BuildRecord, BuildStore } from '@defrex/autobuild/plugin-sdk'
import { reduceBuild, reduceHarvest } from '@defrex/autobuild/remote-store'
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
  if (claims.kind.startsWith('build')) {
    const build = await store.getBuild(claims.id)
    if (build?.repo !== claims.repo) return false
    return evaluateDelegationLifecycle(
      claims,
      { build, buildEvents: await store.getEvents(claims.id) },
      now,
    )
  }
  return evaluateDelegationLifecycle(
    claims,
    { repositoryEvents: await store.getRepoStateEvents(claims.repo) },
    now,
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
    const run = reduceHarvest(events).runs.find((run) => run.run === claims.id)
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
        (event.type === 'harvest.session.ended' && event.payload.session === claims.session)
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
      const events = build
        ? await options.store.getEvents(target.id)
        : await options.store.getRepoStateEvents(repo)
      let anchor: number | undefined
      if ('session' in target) {
        anchor = events.find(
          (event) =>
            (event.type === 'session.started' || event.type === 'harvest.session.started') &&
            event.payload.session === target.session &&
            (!('run' in event.payload) || event.payload.run === target.id),
        )?.seq
      } else if (build) anchor = events.at(-1)?.seq
      else
        anchor = events.find(
          (event) =>
            event.type === 'harvest.execution.authorized' &&
            event.payload.execution === execution &&
            event.payload.run === target.id,
        )?.seq
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
