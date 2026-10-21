import { readTicketMigrations, resolveTicketRef, type TicketMigrations } from './ticket-migrations'
import type { BuildState } from './reducer'
import type { TicketSource, TicketListing } from '../ports/types'
import type { BuildStore, BuildRecord } from '../store/types'
import { readBuildFacts } from '../store/reduced-reads'
import { DISPATCHER } from '../events/envelope'
import type { EventPayload } from '../events/payloads'

/** One exhaustive source sample shared by every node in a dispatcher pass.
 * Scheduling may be cached; publication always requests a sample from this pass. */
export interface IntegrationObservationInputs {
  migrations?: TicketMigrations
  listing: TicketListing
  builds: { record: BuildRecord; state: BuildState }[]
}
export async function integrationObservationInputs(
  store: BuildStore,
  tickets: TicketSource,
  repo: string,
): Promise<IntegrationObservationInputs> {
  if (!tickets.integrationTree || !tickets.listAll)
    throw new Error('ticket source cannot establish exhaustive integration completeness')
  const listing = await tickets.listAll()
  const builds = []
  for (const record of await store.listBuildsForRepo(repo))
    builds.push({ record, state: (await readBuildFacts(store, record.slug)).value.state })
  return { listing, builds, migrations: await readTicketMigrations(store, repo) }
}

/** A failed or partial enumeration cannot authorize verification or publication. */
export async function observeIntegration(
  store: BuildStore,
  tickets: TicketSource,
  slug: string,
  inputs?: () => Promise<IntegrationObservationInputs>,
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
    if (!record?.ticket || !tickets.integrationTree || !tickets.listAll)
      throw new Error('ticket source cannot establish exhaustive integration completeness')
    const {
      listing,
      builds,
      migrations: supplied,
    } = await (inputs ? inputs() : integrationObservationInputs(store, tickets, record.repo))
    const migrations = supplied ?? (await readTicketMigrations(store, record.repo))
    const nodeRef = resolveTicketRef(migrations, record.ticket, tickets.name, slug)
    observation.membershipSource = tickets.name
    const current = (build: BuildRecord) =>
      build.ticket
        ? resolveTicketRef(migrations, build.ticket, tickets.name, build.slug)
        : undefined
    observation.diagnostics.push(...listing.diagnostics)
    for (const ticket of listing.tickets)
      if (ticket.target === nodeRef.id && !ticket.resolved) children.add(ticket.ref.id)
    // Frozen claims survive edits to the source ticket's target.
    for (const { record: build, state: child } of builds) {
      if (child.target?.build === slug && child.status !== 'done' && child.status !== 'aborted')
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
          builds.some(
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
    for (const { record: build, state: child } of builds) {
      if (
        !build.ticket ||
        child.target?.build !== slug ||
        child.status === 'done' ||
        child.status === 'aborted'
      )
        continue
      const ref = current(build)!
      if (ref.source === build.ticket.source && ref.id === build.ticket.id) continue
      const entry = display.get(JSON.stringify([ref.source, ref.id]))
      if (entry) entry.claims = [...new Set([...(entry.claims ?? []), build.slug])].sort()
    }
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
