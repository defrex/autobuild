import type { BuildState } from './reducer'
import type { TicketSource, TicketListing } from '../ports/types'
import type { BuildStore, BuildRecord } from '../store/types'
import { readBuildFacts } from '../store/reduced-reads'
import { DISPATCHER } from '../events/envelope'
import type { EventPayload } from '../events/payloads'

/** One exhaustive source sample shared by every node in a dispatcher pass.
 * Scheduling may be cached; publication always requests a sample from this pass. */
export interface IntegrationObservationInputs {
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
  return { listing, builds }
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
    openChildren: [],
    diagnostics: [],
    contributions: [...(state.integration?.observation?.contributions ?? [])],
  }
  const children = new Set<string>()
  observation.children = state.integration?.observation?.children

  try {
    if (!record?.ticket || !tickets.integrationTree || !tickets.listAll)
      throw new Error('ticket source cannot establish exhaustive integration completeness')
    if (record.ticket.source !== tickets.name)
      throw new Error('configured ticket source differs from the frozen node source')
    const { listing, builds } = await (inputs
      ? inputs()
      : integrationObservationInputs(store, tickets, record.repo))
    observation.diagnostics.push(...listing.diagnostics)
    for (const ticket of listing.tickets)
      if (ticket.target === record.ticket.id && !ticket.resolved) children.add(ticket.ref.id)
    // Frozen claims survive edits to the source ticket's target.
    for (const { record: build, state: child } of builds) {
      if (child.target?.build === slug && child.status !== 'done' && child.status !== 'aborted')
        children.add(build.ticket?.id ?? build.slug)
      if (
        [child.nodeRestack?.parentRequest, child.nodeRestack?.parentChange].some(
          (move) => move && (move.old.target?.build === slug || move.next.target?.build === slug),
        )
      )
        children.add(build.ticket?.id ?? build.slug)
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
        build?.ticket?.source ?? record.ticket.source,
        build?.ticket?.id ?? contribution,
        build?.ticket?.title,
        contribution,
      )
    }
    for (const { record: build } of builds)
      if (children.has(build.ticket?.id ?? build.slug))
        put(
          build.ticket?.source ?? record.ticket.source,
          build.ticket?.id ?? build.slug,
          build.ticket?.title,
        )
    for (const ticket of listing.tickets)
      if (
        (ticket.ref.source === record.ticket.source && children.has(ticket.ref.id)) ||
        display.has(JSON.stringify([ticket.ref.source, ticket.ref.id]))
      )
        put(ticket.ref.source, ticket.ref.id, ticket.title, undefined, true)
    for (const id of children) put(record.ticket.source, id)
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
