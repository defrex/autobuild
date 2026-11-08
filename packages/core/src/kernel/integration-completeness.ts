import { readTicketMigrations, resolveTicketRef, type TicketMigrations } from './ticket-migrations'
import type { BuildState } from './reducer'
import type { TicketSource, TicketListing } from '../ports/types'
import type { BuildStore, BuildRecord } from '../store/types'
import { readBuildDigests, readBuildFacts } from '../store/reduced-reads'
import { digestNodeTargets } from '../store/digest'
import { DISPATCHER } from '../events/envelope'
import type { EventPayload } from '../events/payloads'
import { contributedIssueLinks } from './node-issue-links'
import { holdsState } from '../ports/tickets/lifecycle'

/** The pass's source sample: either one exhaustive listing shared by every
 * node, or, when the source lists one node's targeting tickets, a per-node
 * targeted listing memoized for the pass. Scheduling may be cached;
 * publication always requests a sample from this pass. */
export interface IntegrationObservationInputs {
  migrations?: TicketMigrations
  listing?: TicketListing
  targeting?: (nodeId: string) => Promise<TicketListing>
  /** Every repository build with the node slugs its digest names, a superset
   * of every node it targets or moves between. */
  builds: { record: BuildRecord; nodeTargets: readonly string[] }[]
  /** Current facts for one build; memoized for this sample. */
  state: (slug: string) => Promise<BuildState>
}

function canEnumerate(tickets: TicketSource): boolean {
  return !!tickets.integrationTree && (!!tickets.listAll || !!tickets.listTargeting)
}

/** One targeted listing per node for the life of an inputs object; a failed
 * read is forgotten so a later pass retries it. */
function memoizedTargeting(
  tickets: TicketSource & { listTargeting: NonNullable<TicketSource['listTargeting']> },
): (nodeId: string) => Promise<TicketListing> {
  // Captured once: the targeting decision is fixed for the pass, so a source
  // that withdraws it later fails closed rather than falling back to listAll.
  const list = tickets.listTargeting.bind(tickets)
  const listings = new Map<string, Promise<TicketListing>>()
  return (nodeId) => {
    let listing = listings.get(nodeId)
    if (listing === undefined) {
      listing = list(nodeId)
      listings.set(nodeId, listing)
      listing.catch(() => listings.delete(nodeId))
    }
    return listing
  }
}
export async function integrationObservationInputs(
  store: BuildStore,
  tickets: TicketSource,
  repo: string,
): Promise<IntegrationObservationInputs> {
  if (!canEnumerate(tickets))
    throw new Error('ticket source cannot establish exhaustive integration completeness')
  const sample: Pick<IntegrationObservationInputs, 'listing' | 'targeting'> = tickets.listTargeting
    ? { targeting: memoizedTargeting(tickets as Parameters<typeof memoizedTargeting>[0]) }
    : { listing: await tickets.listAll!() }
  // Records before digests, so a concurrent create cannot break completeness.
  const records = await store.listBuildsForRepo(repo)
  const digests = await readBuildDigests(store, repo)
  const builds = records.map((record) => {
    const digest = digests.get(record.slug)
    if (digest === undefined)
      throw new Error(`build digest missing for ${record.slug}: the digest read broke completeness`)
    return { record, nodeTargets: digestNodeTargets(digest) }
  })
  const states = new Map<string, Promise<BuildState>>()
  const state = (slug: string) => {
    let read = states.get(slug)
    if (!read) {
      read = readBuildFacts(store, slug).then((facts) => facts.value.state)
      states.set(slug, read)
    }
    return read
  }
  return { ...sample, builds, state, migrations: await readTicketMigrations(store, repo) }
}

/** A failed or partial enumeration cannot authorize verification or publication. */
export async function observeIntegration(
  store: BuildStore,
  tickets: TicketSource,
  slug: string,
  inputs?: () => Promise<IntegrationObservationInputs>,
  /** The configured rejected role: a child ticket in it no longer keeps the
   * node incomplete. Unset means no such role. `onFailure` reports an
   * enumeration or observation failure that is recorded as a diagnostic, so a
   * caller can tell it apart from incompleteness; it is never persisted. */
  options: { rejectedState?: string; onFailure?: (error: unknown) => void } = {},
): Promise<EventPayload<'integration.observed'>> {
  const record = await store.getBuild(slug)
  const state = (await readBuildFacts(store, slug)).value.state
  const observation: EventPayload<'integration.observed'> = {
    membershipSource: state.integration?.observation?.membershipSource,
    openChildren: [],
    diagnostics: [],
    contributions: [...(state.integration?.observation?.contributions ?? [])],
  }
  const children = new Set<string>()
  observation.children = state.integration?.observation?.children

  try {
    if (!record?.ticket || !canEnumerate(tickets))
      throw new Error('ticket source cannot establish exhaustive integration completeness')
    const {
      listing: shared,
      targeting,
      builds,
      state: facts,
      migrations: supplied,
    } = await (inputs ? inputs() : integrationObservationInputs(store, tickets, record.repo))
    // Only builds whose digest names this node can relate to it; the rest
    // never need a facts read.
    const related = await Promise.all(
      builds
        .filter((build) => build.nodeTargets.includes(slug))
        .map(async (build) => ({ record: build.record, state: await facts(build.record.slug) })),
    )
    const migrations = supplied ?? (await readTicketMigrations(store, record.repo))
    const nodeRef = resolveTicketRef(migrations, record.ticket, tickets.name, slug)
    const listing = shared ?? (await targeting?.(nodeRef.id))
    if (listing === undefined)
      throw new Error('ticket source cannot establish exhaustive integration completeness')
    observation.membershipSource = tickets.name
    const current = (build: BuildRecord) =>
      build.ticket
        ? resolveTicketRef(migrations, build.ticket, tickets.name, build.slug)
        : undefined
    observation.diagnostics.push(...listing.diagnostics)
    for (const ticket of listing.tickets)
      if (
        ticket.target === nodeRef.id &&
        !ticket.resolved &&
        !holdsState(ticket.state, options.rejectedState)
      )
        children.add(ticket.ref.id)
    // Frozen claims survive edits to the source ticket's target.
    for (const { record: build, state: child } of related) {
      if (child.target?.build === slug && child.status !== 'done' && child.status !== 'aborted')
        children.add(current(build)?.id ?? build.slug)
      // A merged contribution whose links the node has not recorded stays open
      // until its merge or abort cleanup appends them, however its ticket moved.
      if (
        child.target?.build === slug &&
        child.prState === 'merged' &&
        child.outcome === undefined &&
        !state.nodeIssueLinks?.builds.includes(build.slug) &&
        contributedIssueLinks(child).length > 0
      )
        children.add(current(build)?.id ?? build.slug)
      if (
        [child.nodeRestack?.parentRequest, child.nodeRestack?.parentChange].some(
          (move) => move && (move.old.target?.build === slug || move.next.target?.build === slug),
        )
      )
        children.add(current(build)?.id ?? build.slug)
      if (child.target?.build === slug && child.prState === 'merged')
        observation.contributions.push(build.slug)
    }
    observation.contributions.push(...(state.nodeRestack?.inventory?.contributions ?? []))
    // Membership stays in the existing lifecycle arrays. This is display-only.
    const display = new Map<string, NonNullable<typeof observation.children>[number]>()
    const put = (
      source: string,
      id: string,
      title?: string,
      contribution?: string,
      fresh = false,
    ) => {
      const key = JSON.stringify([source, id])
      const previous =
        display.get(key) ??
        state.integration?.observation?.children?.find((c) => c.source === source && c.id === id)
      display.set(key, {
        source,
        id,
        ...(previous ?? {}),
        ...((fresh ? title : (previous?.title ?? title))
          ? { title: fresh ? title : (previous?.title ?? title) }
          : {}),
        ...(contribution
          ? {
              builds: [...new Set([...(previous?.builds ?? []), contribution])]
                .filter((b) => observation.contributions.includes(b))
                .sort(),
            }
          : {}),
      })
    }
    for (const contribution of [...new Set(observation.contributions)].sort()) {
      const build = builds.find((b) => b.record.slug === contribution)?.record
      put(
        build ? (current(build)?.source ?? tickets.name) : tickets.name,
        build ? (current(build)?.id ?? contribution) : contribution,
        build?.ticket?.title,
        contribution,
      )
    }
    for (const { record: build } of builds)
      if (
        (build.ticket?.source === tickets.name ||
          related.some(
            (entry) =>
              entry.record.slug === build.slug &&
              (entry.state.target?.build === slug ||
                observation.contributions.includes(build.slug)),
          )) &&
        children.has(current(build)?.id ?? build.slug)
      )
        put(
          current(build)?.source ?? tickets.name,
          current(build)?.id ?? build.slug,
          build.ticket?.title,
        )
    for (const { record: build, state: child } of related) {
      if (
        !build.ticket ||
        child.target?.build !== slug ||
        child.status === 'done' ||
        child.status === 'aborted'
      )
        continue
      const ref = current(build)!
      if (
        ref.source === build.ticket.source &&
        ref.id === build.ticket.id &&
        nodeRef.source === record.ticket.source &&
        nodeRef.id === record.ticket.id
      )
        continue
      const entry = display.get(JSON.stringify([ref.source, ref.id]))
      if (entry) entry.claims = [...new Set([...(entry.claims ?? []), build.slug])].sort()
    }
    // A targeted listing holds only current children, so a contribution whose
    // ticket has since moved keeps its previous or build title. Display only:
    // membership above does not depend on it.
    for (const ticket of listing.tickets)
      if (
        (ticket.ref.source === tickets.name && children.has(ticket.ref.id)) ||
        display.has(JSON.stringify([ticket.ref.source, ticket.ref.id]))
      )
        put(ticket.ref.source, ticket.ref.id, ticket.title, undefined, true)
    for (const id of children) put(tickets.name, id)
    if (observation.diagnostics.length)
      for (const previous of state.integration?.observation?.children ?? [])
        if (!display.has(JSON.stringify([previous.source, previous.id])))
          display.set(JSON.stringify([previous.source, previous.id]), previous)
    observation.children = [...display.values()].sort(
      (a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
    )
  } catch (error) {
    observation.diagnostics.push(error instanceof Error ? error.message : String(error))
    options.onFailure?.(error)
  }
  observation.openChildren = [...children].sort()
  observation.diagnostics.sort()
  observation.contributions = [...new Set(observation.contributions)].sort()
  if (JSON.stringify(observation) !== JSON.stringify(state.integration?.observation))
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'integration.observed',
      payload: observation,
    })
  return observation
}
