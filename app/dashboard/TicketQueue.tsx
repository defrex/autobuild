'use client'

import type {
  OperatorTicketBuild,
  OperatorTicketCreateRequest,
  OperatorTicketDetail,
  OperatorTicketQueue,
} from 'autobuild/operator-api'
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as api from './api'
import { DashboardSurface, Fastext, type FastextCell, LoadingRows, Rule } from './frame'
import {
  draftFromTicket,
  groupTickets,
  parseLabels,
  reconcileTicketDetail,
  type TicketDraft,
  ticketUpdatePatch,
} from './ticket-view-model'

export interface TicketsViewProps {
  repo: string
  queue?: OperatorTicketQueue
  selected?: string
  detail?: OperatorTicketDetail
  draft?: TicketDraft
  dirty: boolean
  pending: boolean
  creating: boolean
  stateFilter: string
  labelFilter: string
  onStateFilter: (value: string) => void
  onLabelFilter: (value: string) => void
  onOpen: (id: string) => void
  onClose: () => void
  onEdit: (draft: TicketDraft) => void
  onSave: () => void
  onMove: (state: string) => void
  onBlock: (ids: string[], operation: 'block' | 'unblock') => void
  onCreate: (value: OperatorTicketCreateRequest) => void
  onToggleCreate: () => void
  onOpenBuild: (build: OperatorTicketBuild) => void
}

/** The Tickets surface as pure presentation over the polled queue. */
export function TicketsView(props: TicketsViewProps) {
  const { repo, queue, selected, detail, draft, dirty, pending, creating } = props
  const cells: readonly [FastextCell?, FastextCell?, FastextCell?, FastextCell?] = [
    selected ? { key: 'Esc', label: 'CLOSE', onPress: props.onClose } : undefined,
    detail && draft
      ? { key: 's', label: 'SAVE', disabled: pending || !dirty, onPress: props.onSave }
      : undefined,
    { key: 'n', label: creating ? 'CANCEL NEW' : 'NEW TICKET', onPress: props.onToggleCreate },
    detail?.build
      ? { key: 'b', label: 'OPEN BUILD', onPress: () => props.onOpenBuild(detail.build!) }
      : undefined,
  ]

  return (
    <DashboardSurface footer={<Fastext label="Ticket controls" cells={cells} />}>
      <section className="ticketQueue" aria-label="Ticket queue">
        <div className="line filterline">
          <label>
            <span className="slack">state</span>
            <span className="selectwrap">
              <select
                value={props.stateFilter}
                onChange={(event) => props.onStateFilter(event.target.value)}
              >
                <option value="">Ready criteria (default)</option>
                {queue?.states.map((state) => (
                  <option key={state}>{state}</option>
                ))}
              </select>
            </span>
          </label>
          <label>
            <span className="slack">labels</span>
            <input
              value={props.labelFilter}
              onChange={(event) => props.onLabelFilter(event.target.value)}
              placeholder="label-a, label-b"
              aria-label="Labels, all required"
            />
          </label>
        </div>
        {queue?.diagnostics.map((diagnostic) => (
          <p className="warn notice" key={diagnostic}>
            {diagnostic}
          </p>
        ))}
        {creating && (
          <CreateTicket
            states={queue?.states ?? []}
            disabled={pending}
            onCancel={props.onToggleCreate}
            onCreate={props.onCreate}
          />
        )}
        {!queue ? (
          <LoadingRows label={`Loading the ticket queue for ${repo}.`} />
        ) : (
          <div className="pages">
            {groupTickets(queue.tickets).map((group) => (
              <section className="page" key={group.state} aria-label={`${group.state} tickets`}>
                <h2>
                  {group.state.toUpperCase()} <span className="count">{group.tickets.length}</span>
                </h2>
                <ol>
                  {group.tickets.map((ticket) => (
                    <li key={ticket.ref.id}>
                      <button
                        type="button"
                        className="trow"
                        aria-pressed={selected === ticket.ref.id}
                        onClick={() =>
                          selected === ticket.ref.id ? props.onClose() : props.onOpen(ticket.ref.id)
                        }
                      >
                        <span className="lane" aria-hidden />
                        <span>
                          <span className="tid">{ticket.ref.id}</span>{' '}
                          <span className="ttitle">{ticket.title}</span>
                        </span>
                        <span className="meta">
                          {ticket.labels.join(', ') || 'no labels'}
                          {ticket.blockedBy?.length ? (
                            <>
                              {' '}
                              <span className="warn">blocked by {ticket.blockedBy.join(', ')}</span>
                            </>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            {queue.tickets.length === 0 && <p className="slack">no tickets matched</p>}
          </div>
        )}
        {detail && draft && (
          <TicketDetail
            value={detail}
            draft={draft}
            states={queue?.states ?? []}
            dirty={dirty}
            disabled={pending}
            onEdit={props.onEdit}
            onClose={props.onClose}
            onSave={props.onSave}
            onMove={props.onMove}
            onBlock={props.onBlock}
            onOpenBuild={props.onOpenBuild}
          />
        )}
      </section>
    </DashboardSurface>
  )
}

export function TicketQueue({
  repo,
  onError,
  onOpenBuild,
}: {
  repo: string
  onError: (message?: string) => void
  onOpenBuild: (build: OperatorTicketBuild) => void
}) {
  const [queue, setQueue] = useState<OperatorTicketQueue>()
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<OperatorTicketDetail>()
  const [draft, setDraft] = useState<TicketDraft>()
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [stateFilter, setStateFilter] = useState('')
  const [labelFilter, setLabelFilter] = useState('')
  const [pending, setPending] = useState(false)
  const [creating, setCreating] = useState(false)
  const sequence = useRef(0)

  const poll = useCallback(
    async (signal?: AbortSignal) => {
      if (!repo) return
      const current = ++sequence.current
      try {
        const labels = labelFilter === '' ? undefined : parseLabels(labelFilter)
        const [nextQueue, nextDetail] = await Promise.all([
          api.tickets(
            repo,
            {
              ...(stateFilter !== '' ? { state: stateFilter } : {}),
              ...(labels !== undefined ? { labels } : {}),
            },
            signal,
          ),
          selected ? api.ticket(repo, selected, signal) : Promise.resolve(undefined),
        ])
        if (current !== sequence.current) return
        setQueue(nextQueue)
        if (nextDetail) {
          setDetail((old) => reconcileTicketDetail(old, nextDetail, dirtyRef.current))
          if (!dirtyRef.current) setDraft(draftFromTicket(nextDetail.ticket))
        }
        onError(undefined)
      } catch (cause) {
        if (!signal?.aborted) onError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [repo, stateFilter, labelFilter, selected, onError],
  )

  useEffect(() => {
    const controller = new AbortController()
    void poll(controller.signal)
    const timer = window.setInterval(() => void poll(controller.signal), 2000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [poll])

  const act = async (operation: () => Promise<OperatorTicketDetail>) => {
    setPending(true)
    onError(undefined)
    try {
      const next = await operation()
      setDetail(next)
      setSelected(next.ticket.ref.id)
      setDraft(draftFromTicket(next.ticket))
      setDirty(false)
      dirtyRef.current = false
      setCreating(false)
      await poll()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const edit = (next: TicketDraft) => {
    setDraft(next)
    setDirty(true)
    dirtyRef.current = true
  }
  const openTicket = (id: string) => {
    setSelected(id)
    setDetail(undefined)
    setDraft(undefined)
    setDirty(false)
    dirtyRef.current = false
  }
  const close = () => {
    sequence.current += 1
    setSelected(undefined)
    setDetail(undefined)
    setDraft(undefined)
    setDirty(false)
    dirtyRef.current = false
  }
  const save = () => {
    if (!detail || !draft) return
    const patch = ticketUpdatePatch(detail.ticket, draft)
    if (patch) void act(() => api.updateTicket(repo, detail.ticket.ref.id, patch))
  }

  // Esc backs out, the same way it closes a build detail.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {})
  keyHandler.current = (event) => {
    if (event.key !== 'Escape') return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.closest('input, textarea, select')) return
    if (creating) setCreating(false)
    else if (selected) close()
  }
  useEffect(() => {
    const listen = (event: KeyboardEvent) => keyHandler.current(event)
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [])

  return (
    <TicketsView
      repo={repo}
      queue={queue}
      selected={selected}
      detail={detail}
      draft={draft}
      dirty={dirty}
      pending={pending}
      creating={creating}
      stateFilter={stateFilter}
      labelFilter={labelFilter}
      onStateFilter={setStateFilter}
      onLabelFilter={setLabelFilter}
      onOpen={openTicket}
      onClose={close}
      onEdit={edit}
      onSave={save}
      onMove={(state) => {
        if (detail) void act(() => api.moveTicket(repo, detail.ticket.ref.id, state))
      }}
      onBlock={(ids, operation) => {
        if (detail) void act(() => api.changeBlockers(repo, detail.ticket.ref.id, ids, operation))
      }}
      onCreate={(value) => void act(() => api.createTicket(repo, value))}
      onToggleCreate={() => setCreating((value) => !value)}
      onOpenBuild={onOpenBuild}
    />
  )
}

function CreateTicket({
  states,
  disabled,
  onCancel,
  onCreate,
}: {
  states: string[]
  disabled: boolean
  onCancel: () => void
  onCreate: (value: OperatorTicketCreateRequest) => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [labels, setLabels] = useState('')
  const [state, setState] = useState('')
  const [blockers, setBlockers] = useState('')
  return (
    <form
      className="detail tdetail composer"
      aria-label="Create ticket"
      onSubmit={(event) => {
        event.preventDefault()
        onCreate({
          title,
          body,
          ...(labels !== '' ? { labels: parseLabels(labels) } : {}),
          ...(state !== '' ? { state } : {}),
          ...(blockers !== '' ? { blockedBy: parseLabels(blockers) } : {}),
        })
      }}
    >
      <Rule />
      <h3>Create ticket</h3>
      <label className="field">
        <span>title</span>
        <input required value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="field">
        <span>body</span>
        <textarea required value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
      <label className="field">
        <span>labels</span>
        <input
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          placeholder="label-a, label-b"
        />
      </label>
      <label className="field">
        <span>initial state</span>
        <span className="selectwrap">
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">Backend default</option>
            {states.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </span>
      </label>
      <label className="field">
        <span>blocked by</span>
        <input
          value={blockers}
          onChange={(event) => setBlockers(event.target.value)}
          placeholder="TICKET-1, TICKET-2"
        />
      </label>
      <div className="controls">
        <button className="btn" disabled={disabled} type="submit">
          Create
        </button>
        <button type="button" className="word" onClick={onCancel}>
          cancel
        </button>
      </div>
      <Rule />
    </form>
  )
}

function TicketDetail({
  value,
  draft,
  states,
  dirty,
  disabled,
  onEdit,
  onClose,
  onSave,
  onMove,
  onBlock,
  onOpenBuild,
}: {
  value: OperatorTicketDetail
  draft: TicketDraft
  states: string[]
  dirty: boolean
  disabled: boolean
  onEdit: (draft: TicketDraft) => void
  onClose: () => void
  onSave: () => void
  onMove: (state: string) => void
  onBlock: (ids: string[], operation: 'block' | 'unblock') => void
  onOpenBuild: (build: OperatorTicketBuild) => void
}) {
  const [move, setMove] = useState(value.ticket.state ?? '')
  const [blocker, setBlocker] = useState('')
  const titleId = `ticket-${encodeURIComponent(value.ticket.ref.id)}`
  return (
    <article className="detail tdetail" aria-labelledby={titleId}>
      <Rule />
      <div className="kv">
        <h3 id={titleId}>{value.ticket.ref.id}</h3>
        <span>
          <span className="k">state </span>
          {value.ticket.state ?? '(unknown)'}
        </span>
        {value.ticket.ref.url && (
          <a href={value.ticket.ref.url} target="_blank" rel="noreferrer">
            open in {value.ticket.ref.source}
          </a>
        )}
        {value.build && (
          <a
            href={value.build.link}
            onClick={(event) => {
              event.preventDefault()
              onOpenBuild(value.build!)
            }}
          >
            build {value.build.slug} · {value.build.status}
          </a>
        )}
        {dirty && <span className="warn">unsaved changes</span>}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          onSave()
        }}
      >
        <label className="field">
          <span>title</span>
          <input
            value={draft.title}
            onChange={(event) => onEdit({ ...draft, title: event.target.value })}
          />
        </label>
        <label className="field">
          <span>body</span>
          <textarea
            value={draft.body}
            onChange={(event) => onEdit({ ...draft, body: event.target.value })}
          />
        </label>
        <label className="field">
          <span>labels, complete replacement</span>
          <input
            value={draft.labels.join(', ')}
            onChange={(event) => onEdit({ ...draft, labels: parseLabels(event.target.value) })}
          />
        </label>
        <div className="controls">
          <button type="submit" className="btn" disabled={disabled || !dirty}>
            Save changes
          </button>
        </div>
      </form>

      <section className="section">
        <h3>Preview</h3>
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
            {draft.body}
          </ReactMarkdown>
        </div>
      </section>

      <section className="section">
        <h3>Move</h3>
        <div className="controls">
          <span className="selectwrap">
            <select value={move} onChange={(event) => setMove(event.target.value)}>
              {states.map((state) => (
                <option key={state}>{state}</option>
              ))}
            </select>
          </span>
          <button
            type="button"
            className="btn"
            disabled={disabled || !move || move === value.ticket.state}
            onClick={() => onMove(move)}
          >
            Move
          </button>
        </div>
      </section>

      <section className="section">
        <h3>Blockers</h3>
        {value.blockers.length ? (
          <ul className="sessions">
            {value.blockers.map((item) => (
              <li key={item.id}>
                <b>{item.id}</b>
                <span className={!item.exists ? 'alert' : item.resolved ? 'ok' : 'warn'}>
                  {!item.exists ? 'missing' : item.resolved ? 'resolved' : 'unresolved'}
                </span>
                <button
                  type="button"
                  className="word"
                  disabled={disabled}
                  onClick={() => onBlock([item.id], 'unblock')}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="slack">no blockers</p>
        )}
        <form
          className="controls"
          onSubmit={(event) => {
            event.preventDefault()
            if (!blocker) return
            onBlock([blocker], 'block')
            setBlocker('')
          }}
        >
          <input
            className="short"
            value={blocker}
            onChange={(event) => setBlocker(event.target.value)}
            placeholder="ticket id"
            aria-label="Blocker ticket id"
          />
          <button type="submit" className="btn" disabled={disabled || !blocker}>
            Add blocker
          </button>
        </form>
      </section>

      <div className="controls">
        <button type="button" className="word" onClick={onClose}>
          close ticket
        </button>
      </div>
      <Rule />
    </article>
  )
}
