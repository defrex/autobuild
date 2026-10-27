'use client'

import type {
  OperatorTicketDetail,
  OperatorTicketQueue,
} from '@defrex/autobuild-hosted-store-service/operator-api'
import Link from 'next/link'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import * as api from './api'
import { isRowSurfaceClick } from './BuildsView'
import { DashboardSurface, LoadingRows } from './frame'
import { LoadMore } from './LoadMore'
import { Markdown } from './markdown'
import {
  buildLink,
  type TicketTab,
  ticketLink,
  tabLink,
  VIEW_TABS,
  type ViewTab,
} from './project-selection'

export type Ticket = OperatorTicketQueue['tickets'][number]

/** Ticket lists change at grooming speed, not build speed. */
const TICKET_POLL_MS = 15_000

export interface LifecycleNames {
  triage: string
  ready: string
  done: string
}
/** Lifecycle names and per-state counts: everything the tabs need. */
export interface TicketMetaState {
  names?: LifecycleNames
  counts?: Record<string, number>
  error?: string
}
export interface TicketPage {
  tickets?: Ticket[]
  total?: number
  /** How many tickets the page asks for; more than it holds while loading more. */
  requested: number
  error?: string
  loadMore: () => void
}

export const TICKET_PAGE = 25

const metaCache = new Map<string, TicketMetaState>()
const pageCache = new Map<string, { tickets: Ticket[]; total: number }>()
const detailCache = new Map<string, OperatorTicketDetail>()

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Poll while visible, once more on return, and abort whatever is in flight on teardown. */
function usePoll(key: string | undefined, load: (signal: AbortSignal) => Promise<void>): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names everything `load` reads
  useEffect(() => {
    if (key === undefined) return
    let controller: AbortController | undefined
    const run = () => {
      if (document.hidden) return
      controller?.abort()
      controller = new AbortController()
      void load(controller.signal)
    }
    run()
    const timer = setInterval(run, TICKET_POLL_MS)
    const onVisibility = () => {
      if (!document.hidden) run()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      controller?.abort()
    }
  }, [key])
}

/**
 * The lifecycle names, read once per project from an empty listing so the
 * client never guesses a provider's state names, and the per-state counts,
 * polled. `version` changes after a write to refresh at once.
 */
export function useTicketMeta(repo: string, version: number): TicketMetaState {
  const [meta, setMeta] = useState<TicketMetaState>(() => metaCache.get(repo) ?? {})
  usePoll(repo ? `${repo}:${version}` : undefined, async (signal) => {
    try {
      const known = metaCache.get(repo)?.names
      const [names, states] = await Promise.all([
        known ??
          api.tickets(repo, undefined, { limit: 0 }, signal).then((listing) => ({
            triage: listing.triageState,
            ready: listing.readyState,
            done: listing.doneState,
          })),
        api.ticketStates(repo, signal),
      ])
      const next = {
        names,
        counts: Object.fromEntries(states.map((state) => [state.name, state.tickets])),
      }
      metaCache.set(repo, next)
      setMeta(next)
    } catch (cause) {
      if (!signal.aborted) setMeta((old) => ({ ...old, error: message(cause) }))
    }
  })
  return meta
}

/**
 * One state's tickets, a page at a time from the top of the list. Polling
 * refreshes everything loaded so far; `loadMore` asks for one more page.
 */
export function usePagedTickets(
  repo: string,
  state: string | undefined,
  order: 'oldest' | 'newest',
  version: number,
): TicketPage {
  const cacheKey = `${repo}:${state}:${order}`
  const cached = pageCache.get(cacheKey)
  const [requested, setRequested] = useState(() =>
    Math.max(TICKET_PAGE, cached?.tickets.length ?? 0),
  )
  const [page, setPage] = useState(cached)
  const [error, setError] = useState<string>()
  usePoll(
    repo && state !== undefined ? `${cacheKey}:${requested}:${version}` : undefined,
    async (signal) => {
      try {
        const listing = await api.tickets(repo, state, { limit: requested, order }, signal)
        const next = { tickets: listing.tickets, total: listing.total }
        pageCache.set(cacheKey, next)
        setPage(next)
        setError(undefined)
      } catch (cause) {
        if (!signal.aborted) setError(message(cause))
      }
    },
  )
  const total = page?.total
  const loadMore = useCallback(() => {
    setRequested((count) => (total !== undefined && count >= total ? count : count + TICKET_PAGE))
  }, [total])
  return { ...page, requested, ...(error ? { error } : {}), loadMore }
}

export function useTicketDetail(
  repo: string,
  id: string | undefined,
  version: number,
): { detail?: OperatorTicketDetail; error?: string } {
  const key = id === undefined ? undefined : `${repo}:${id}`
  const [state, setState] = useState<{ detail?: OperatorTicketDetail; error?: string }>(() => ({
    detail: key ? detailCache.get(key) : undefined,
  }))
  usePoll(key === undefined ? undefined : `${key}:${version}`, async (signal) => {
    try {
      const detail = await api.ticket(repo, id!, signal)
      detailCache.set(key!, detail)
      setState({ detail })
    } catch (cause) {
      if (!signal.aborted) setState((old) => ({ ...old, error: message(cause) }))
    }
  })
  return state
}

/** The tab a ticket in `state` belongs to; claimed tickets are active builds. */
export function tabForState(
  state: string | undefined,
  names?: LifecycleNames,
): ViewTab | undefined {
  if (state === undefined || names === undefined) return undefined
  if (state === names.triage) return 'triage'
  if (state === names.ready) return 'queue'
  if (state === names.done) return 'done'
  return 'active'
}

const TAB_LABEL: Record<ViewTab, string> = {
  triage: 'Triage',
  queue: 'Queue',
  active: 'Active',
  done: 'Done',
}

/**
 * The operator's top-level navigation. `current` marks the open view; on a
 * build or ticket page the owning tab stays marked without claiming the page.
 */
export function ViewTabs({
  repo,
  current,
  page,
  counts,
}: {
  repo: string
  current?: ViewTab
  /** Whether the current tab's own list is the page being shown. */
  page: boolean
  counts: Partial<Record<ViewTab, ReactNode>>
}) {
  return (
    <nav className="tabs" aria-label="Views">
      {VIEW_TABS.map((tab) => (
        <Link
          key={tab}
          className="tab"
          href={tabLink(repo, tab)}
          aria-current={tab === current ? (page ? 'page' : 'true') : undefined}
        >
          {TAB_LABEL[tab]}
          {counts[tab] !== undefined ? (
            <span className="count">{counts[tab]}</span>
          ) : (
            // Done has no count; the others hold their place until it arrives.
            tab !== 'done' && <span className="count pending" aria-hidden="true" />
          )}
        </Link>
      ))}
    </nav>
  )
}

const EMPTY: Record<TicketTab, string> = {
  triage:
    'Nothing in triage. New tickets and harvested proposals wait here until someone grooms them with the operator agent.',
  queue:
    'Nothing ready. Groomed tickets wait here until the dispatcher has a free build slot and intake is on.',
  done: 'No finished tickets yet.',
}

/** The body's first paragraph, flattened to plain text for a row preview. */
export function excerpt(body: string): string {
  const paragraph =
    body
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part && !/^(#|```|~~~|[-*+] |\d+[.)] )/.test(part)) ?? ''
  return paragraph
    .replace(/^>\s?/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
}

/**
 * A listing names declared blockers but only sometimes says whether they are
 * resolved. Unresolved is shown as blocked; unknown is shown as a dependency.
 */
function dependencies(ticket: Ticket): { ids: string[]; blocked: boolean } {
  if (ticket.blockersResolved) return { ids: [], blocked: false }
  return { ids: ticket.blockedBy ?? [], blocked: ticket.blockersResolved === false }
}

export function TicketListView({
  repo,
  tab,
  page,
  onOpenTicket,
}: {
  repo: string
  tab: TicketTab
  page: TicketPage
  onOpenTicket: (href: string) => void
}) {
  const { tickets, total, error } = page
  if (!tickets || total === undefined) {
    return (
      <DashboardSurface>
        {error ? (
          <p className="alert notice">{error}</p>
        ) : (
          <LoadingRows kind="tickets" label={`Loading ${TAB_LABEL[tab].toLowerCase()} tickets.`} />
        )}
      </DashboardSurface>
    )
  }
  const loadingMore = page.requested > tickets.length && tickets.length < total
  return (
    <DashboardSurface>
      {error && <p className="warn notice">{error}</p>}
      <ol className="rows ticket-rows" aria-label={`${TAB_LABEL[tab]} tickets`}>
        {tickets.map((ticket) => {
          const href = ticketLink(repo, ticket.ref.id)
          const preview = excerpt(ticket.body)
          const blockers = dependencies(ticket)
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the row surface is a pointer convenience; the title link is the keyboard path
            <li
              key={ticket.ref.id}
              className="row"
              onClick={(event) => {
                if (isRowSurfaceClick(event.target as Element, window.getSelection()?.toString()))
                  onOpenTicket(href)
              }}
            >
              <div className="rowline">
                <span className="lane" aria-hidden />
                <Link className="rowhead" href={href} aria-label={`Open ${ticket.ref.id}`}>
                  <span className="ticket">{ticket.ref.id}</span>
                  <span className="build-title">{ticket.title}</span>
                </Link>
              </div>
              <TicketMeta repo={repo} ticket={ticket} blockers={blockers} />
              {preview && <p className="ticket-excerpt">{preview}</p>}
            </li>
          )
        })}
        {tickets.length === 0 && <li className="slack empty">{EMPTY[tab]}</li>}
      </ol>
      {loadingMore && (
        <LoadingRows
          kind="tickets"
          rows={Math.min(3, total - tickets.length)}
          label="Loading more tickets."
        />
      )}
      <LoadMore shown={tickets.length} total={total} loading={loadingMore} onMore={page.loadMore} />
    </DashboardSurface>
  )
}

function TicketMeta({
  repo,
  ticket,
  blockers,
  children,
}: {
  repo: string
  ticket: Ticket
  blockers: { ids: string[]; blocked: boolean }
  children?: ReactNode
}) {
  const facts: ReactNode[] = []
  if (ticket.kind === 'node') facts.push('node')
  if (ticket.target) facts.push(<>target {ticket.target}</>)
  for (const label of ticket.labels) facts.push(<span className="label">{label}</span>)
  if (blockers.ids.length)
    facts.push(
      <span className={blockers.blocked ? 'warn' : undefined}>
        {blockers.blocked ? 'blocked by' : 'depends on'}{' '}
        {blockers.ids.map((id, index) => (
          <span key={id}>
            {index > 0 && ', '}
            <Link className="word ticket-ref" href={ticketLink(repo, id)}>
              {id}
            </Link>
          </span>
        ))}
      </span>,
    )
  if (!facts.length && !children) return null
  return (
    <div className="build-meta ticket-meta">
      {facts.map((fact, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: facts are positional and rebuilt each render
        <span key={index}>
          {index > 0 && ' · '}
          {fact}
        </span>
      ))}
      {children}
    </div>
  )
}

const TERMINAL_BUILD = new Set(['merged', 'closed', 'aborted', 'discarded', 'failed'])

/** The moves a ticket offers from where it sits: grooming, not authoring. */
export function ticketMoves(
  state: string | undefined,
  names: LifecycleNames | undefined,
  counts: Record<string, number> | undefined,
): TicketMove[] {
  if (!names || state === undefined) return []
  if (state === names.triage)
    return [
      { label: 'ENQUEUE', state: names.ready, emphasis: 'primary' },
      // The icebox is a repository-defined state, offered only where it exists.
      ...(counts && ICEBOX in counts
        ? [{ label: 'ICE', state: ICEBOX, emphasis: 'ghost' as const }]
        : []),
    ]
  if (state === names.ready) return [{ label: 'DEQUEUE', state: names.triage, emphasis: 'primary' }]
  return []
}
export interface TicketMove {
  label: string
  state: string
  emphasis: 'primary' | 'ghost'
}
const ICEBOX = 'icebox'

export function TicketPageView({
  repo,
  id,
  detail,
  error,
  moves = [],
  pending = false,
  onMove,
}: {
  repo: string
  id: string
  detail?: OperatorTicketDetail
  error?: string
  moves?: TicketMove[]
  pending?: boolean
  onMove?: (move: TicketMove) => void
}) {
  if (!detail) {
    return (
      <DashboardSurface>
        {error ? (
          <p className="alert notice">{error}</p>
        ) : (
          <LoadingRows kind="ticket-page" label={`Loading ${id}.`} />
        )}
      </DashboardSurface>
    )
  }
  const { ticket, build } = detail
  const blockers = {
    ids: detail.blockers.filter((blocker) => !blocker.resolved).map((b) => b.id),
    blocked: true,
  }
  return (
    <DashboardSurface>
      {error && <p className="warn notice">{error}</p>}
      <article className="build-page ticket-page" aria-label={ticket.ref.id}>
        <header className="build-head">
          <div className="rowline">
            <span className="lane" aria-hidden />
            <h2 className="rowhead">
              <span className="ticket">{ticket.ref.id}</span>
              <span className="build-title">{ticket.title}</span>
            </h2>
            {ticket.state && (
              <span className="status ticket-state">{ticket.state.toUpperCase()}</span>
            )}
          </div>
          <TicketMeta repo={repo} ticket={ticket} blockers={blockers}>
            {build && (
              <span className="tokens">
                <span>
                  build{' '}
                  {TERMINAL_BUILD.has(build.status) ? (
                    <span className="slug">{build.slug}</span>
                  ) : (
                    <Link className="word slug" href={buildLink(repo, build.slug)}>
                      {build.slug}
                    </Link>
                  )}{' '}
                  {build.status}
                </span>
              </span>
            )}
          </TicketMeta>
          {moves.length > 0 && (
            <div
              className="controls actions build-actions"
              role="toolbar"
              aria-label={`Moves for ${ticket.ref.id}`}
            >
              {moves.map((move) => (
                <button
                  type="button"
                  key={move.state}
                  className={`btn ${move.emphasis} action`}
                  disabled={pending}
                  aria-label={`${move.label} ${ticket.ref.id}`}
                  onClick={() => onMove?.(move)}
                >
                  {move.label}
                </button>
              ))}
            </div>
          )}
        </header>
        <TicketContent ticket={ticket} />
      </article>
    </DashboardSurface>
  )
}

/** The body without a leading heading that only repeats the ticket's title. */
export function bodyWithoutTitle(body: string, title: string): string {
  const match = body.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*(?:\n|$)/)
  return match && match[1]!.trim().toLowerCase() === title.trim().toLowerCase()
    ? body.slice(match[0].length)
    : body
}

export function TicketContent({ ticket }: { ticket: Ticket }) {
  const body = bodyWithoutTitle(ticket.body, ticket.title)
  return (
    <>
      <section className="section ticket-body" aria-label="Ticket">
        {body.trim() ? (
          <Markdown source={body} />
        ) : (
          <p className="slack">This ticket has no description.</p>
        )}
      </section>
      {ticket.comments && ticket.comments.length > 0 && (
        <section className="section ticket-comments">
          <h3>Comments</h3>
          {ticket.comments.map((comment, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: comments are an append-only history
            <Markdown key={index} className="comment" source={comment.body} />
          ))}
        </section>
      )}
    </>
  )
}

/** The build page's ticket: loaded by the build's ticket id, quiet when absent. */
export function BuildTicketSection({
  ticketId,
  detail,
  error,
}: {
  ticketId?: string
  detail?: OperatorTicketDetail
  error?: string
}) {
  if (!ticketId) return null
  return (
    <section className="section build-ticket" aria-label={`Ticket ${ticketId}`}>
      <h3>Ticket</h3>
      {detail ? (
        <TicketContent ticket={detail.ticket} />
      ) : error ? (
        <p className="slack">
          Ticket {ticketId} is unavailable: {error}
        </p>
      ) : (
        <LoadingRows kind="ticket-body" label={`Loading ticket ${ticketId}.`} />
      )}
    </section>
  )
}
