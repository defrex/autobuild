'use client'

import type {
  OperatorTicketBuild,
  OperatorTicketCreateRequest,
  OperatorTicketDetail,
  OperatorTicketQueue,
} from 'autobuild/operator-api'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import { DashboardSurface, Fastext, type FastextCell, LoadingRows, Rule } from './frame'
import { MarkdownBodyEditor } from './MarkdownBodyEditor'
import {
  draftFromTicket,
  parseLabels,
  queueSelection,
  reconcileTicketDetail,
  selectionAfterRemoval,
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
  onPromote: () => void
  onBlock: (ids: string[], operation: 'block' | 'unblock') => void
  onCreate: (value: OperatorTicketCreateRequest) => void
  onToggleCreate: () => void
  onOpenBuild: (build: OperatorTicketBuild) => void
}

/** The Tickets surface as pure presentation over one configured-state queue. */
export function TicketsView(props: TicketsViewProps) {
  const { repo, queue, selected, detail, draft, dirty, pending, creating } = props
  const promotable =
    detail !== undefined && queue !== undefined && detail.ticket.state === queue.triageState
  const cells: readonly [FastextCell?, FastextCell?, FastextCell?, FastextCell?] = [
    selected ? { key: 'Esc', label: 'CLOSE', onPress: props.onClose } : undefined,
    promotable
      ? {
          key: 'p',
          label: `TO ${queue.readyState.toUpperCase()}`,
          disabled: pending,
          onPress: props.onPromote,
        }
      : detail && dirty
        ? { key: 's', label: 'SAVE', disabled: pending, onPress: props.onSave }
        : undefined,
    { key: 'n', label: creating ? 'CANCEL NEW' : 'NEW TICKET', onPress: props.onToggleCreate },
    detail?.build
      ? { key: 'b', label: 'OPEN BUILD', onPress: () => props.onOpenBuild(detail.build!) }
      : undefined,
  ]

  return (
    <DashboardSurface footer={<Fastext label="Ticket controls" cells={cells} />}>
      <section className="ticketQueue" aria-label="Ticket list">
        <div className="line filterline">
          <label>
            <span className="slack">state</span>
            <span className="selectwrap">
              <select
                value={props.stateFilter}
                onChange={(event) => props.onStateFilter(event.target.value)}
              >
                <option value="">{queue?.triageState ?? 'Configured default'}</option>
                {queue?.states
                  .filter((state) => state !== queue.triageState)
                  .map((state) => (
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
          <section
            className="page ticketPage"
            aria-label={`${queue.criteria.state ?? queue.triageState} tickets`}
          >
            <h2>
              {(queue.criteria.state ?? queue.triageState).toUpperCase()}{' '}
              <span className="count">{queue.tickets.length}</span>
            </h2>
            {queue.tickets.length > 0 ? (
              <ol>
                {queue.tickets.map((ticket) => {
                  const open = selected === ticket.ref.id
                  return (
                    <li key={ticket.ref.id} data-selected={open || undefined}>
                      <button
                        type="button"
                        className="trow"
                        aria-pressed={open}
                        onClick={() => props.onOpen(ticket.ref.id)}
                      >
                        <span className="lane" aria-hidden>
                          {open ? '>' : ''}
                        </span>
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
                      {open && detail && draft && (
                        <TicketDetail
                          value={detail}
                          draft={draft}
                          states={queue.states}
                          readyState={queue.readyState}
                          promotable={promotable}
                          dirty={dirty}
                          disabled={pending}
                          onEdit={props.onEdit}
                          onClose={props.onClose}
                          onSave={props.onSave}
                          onMove={props.onMove}
                          onPromote={props.onPromote}
                          onBlock={props.onBlock}
                          onOpenBuild={props.onOpenBuild}
                          onNew={props.onToggleCreate}
                        />
                      )}
                    </li>
                  )
                })}
              </ol>
            ) : (
              <p className="slack emptyTickets">
                Nothing is waiting in {queue.criteria.state ?? queue.triageState}.
              </p>
            )}
          </section>
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
  const selectionClosed = useRef(false)
  const [stateFilter, setStateFilter] = useState('')
  const [labelFilter, setLabelFilter] = useState('')
  const [pending, setPending] = useState(false)
  const [creating, setCreating] = useState(false)
  const sequence = useRef(0)

  const filters = useCallback(() => {
    const labels = labelFilter === '' ? undefined : parseLabels(labelFilter)
    return {
      ...(stateFilter !== '' ? { state: stateFilter } : {}),
      ...(labels !== undefined ? { labels } : {}),
    }
  }, [stateFilter, labelFilter])

  const poll = useCallback(
    async (signal?: AbortSignal) => {
      if (!repo) return
      const current = ++sequence.current
      try {
        const [nextQueue, nextDetail] = await Promise.all([
          api.tickets(repo, filters(), signal),
          selected ? api.ticket(repo, selected, signal) : Promise.resolve(undefined),
        ])
        if (current !== sequence.current) return
        const nextSelected = selectionClosed.current
          ? selected && nextQueue.tickets.some((ticket) => ticket.ref.id === selected)
            ? selected
            : undefined
          : queueSelection(nextQueue.tickets, selected)
        setQueue(nextQueue)
        setSelected(nextSelected)
        if (nextDetail && nextDetail.ticket.ref.id === nextSelected) {
          setDetail((old) => reconcileTicketDetail(old, nextDetail, dirtyRef.current))
          if (!dirtyRef.current) setDraft(draftFromTicket(nextDetail.ticket))
        } else if (nextSelected !== selected) {
          setDetail(undefined)
          setDraft(undefined)
          setDirty(false)
          dirtyRef.current = false
        }
        onError(undefined)
      } catch (cause) {
        if (!signal?.aborted) onError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [repo, filters, selected, onError],
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

  const installDetail = (next: OperatorTicketDetail) => {
    setDetail(next)
    setSelected(next.ticket.ref.id)
    setDraft(draftFromTicket(next.ticket))
    setDirty(false)
    dirtyRef.current = false
    selectionClosed.current = false
  }

  const act = async (operation: () => Promise<OperatorTicketDetail>) => {
    setPending(true)
    onError(undefined)
    try {
      const next = await operation()
      installDetail(next)
      setCreating(false)
      await poll()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const edit = (next: TicketDraft) => {
    const changed = detail ? ticketUpdatePatch(detail.ticket, next) !== null : false
    setDraft(next)
    setDirty(changed)
    dirtyRef.current = changed
  }
  const openTicket = (id: string) => {
    if (id === selected) return
    selectionClosed.current = false
    setSelected(id)
    setDetail(undefined)
    setDraft(undefined)
    setDirty(false)
    dirtyRef.current = false
  }
  const close = () => {
    sequence.current += 1
    selectionClosed.current = true
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

  const promote = async () => {
    if (!queue || !detail || detail.ticket.state !== queue.triageState) return
    const promotedId = detail.ticket.ref.id
    const successor = selectionAfterRemoval(queue.tickets, promotedId)
    setPending(true)
    onError(undefined)
    sequence.current += 1
    try {
      await api.moveTicket(repo, promotedId, queue.readyState)
      const nextQueue = await api.tickets(repo, filters())
      const nextSelected =
        successor && nextQueue.tickets.some((ticket) => ticket.ref.id === successor)
          ? successor
          : queueSelection(nextQueue.tickets)
      const nextDetail = nextSelected ? await api.ticket(repo, nextSelected) : undefined
      setQueue(nextQueue)
      setSelected(nextSelected)
      setDetail(nextDetail)
      setDraft(nextDetail ? draftFromTicket(nextDetail.ticket) : undefined)
      setDirty(false)
      dirtyRef.current = false
      selectionClosed.current = false
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const changeStateFilter = (value: string) => {
    sequence.current += 1
    selectionClosed.current = false
    setStateFilter(value)
    setSelected(undefined)
    setDetail(undefined)
    setDraft(undefined)
    setDirty(false)
    dirtyRef.current = false
  }

  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {})
  keyHandler.current = (event) => {
    const key = event.key.toLowerCase()
    if (key === 'escape') {
      event.preventDefault()
      if (creating) setCreating(false)
      else if (selected) close()
      return
    }
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
    if (key === 'arrowup' || key === 'arrowdown') {
      if (!queue?.tickets.length) return
      event.preventDefault()
      const index = queue.tickets.findIndex((ticket) => ticket.ref.id === selected)
      const delta = key === 'arrowup' ? -1 : 1
      const next = queue.tickets[Math.max(0, Math.min(queue.tickets.length - 1, index + delta))]
      if (next) openTicket(next.ref.id)
    } else if (key === 'p') {
      event.preventDefault()
      void promote()
    } else if (key === 's' && dirty) {
      event.preventDefault()
      save()
    } else if (key === 'n') {
      event.preventDefault()
      setCreating((value) => !value)
    } else if (key === 'b' && detail?.build) {
      event.preventDefault()
      onOpenBuild(detail.build)
    }
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
      onStateFilter={changeStateFilter}
      onLabelFilter={setLabelFilter}
      onOpen={openTicket}
      onClose={close}
      onEdit={edit}
      onSave={save}
      onMove={(state) => {
        if (detail) void act(() => api.moveTicket(repo, detail.ticket.ref.id, state))
      }}
      onPromote={() => void promote()}
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
  readyState,
  promotable,
  dirty,
  disabled,
  onEdit,
  onClose,
  onSave,
  onMove,
  onPromote,
  onBlock,
  onOpenBuild,
  onNew,
}: {
  value: OperatorTicketDetail
  draft: TicketDraft
  states: string[]
  readyState: string
  promotable: boolean
  dirty: boolean
  disabled: boolean
  onEdit: (draft: TicketDraft) => void
  onClose: () => void
  onSave: () => void
  onMove: (state: string) => void
  onPromote: () => void
  onBlock: (ids: string[], operation: 'block' | 'unblock') => void
  onOpenBuild: (build: OperatorTicketBuild) => void
  onNew: () => void
}) {
  const [move, setMove] = useState(value.ticket.state ?? '')
  const [blocker, setBlocker] = useState('')
  const titleId = `ticket-${encodeURIComponent(value.ticket.ref.id)}`
  return (
    <article className="detail tdetail" aria-labelledby={titleId}>
      <Rule />
      <div className="kv ticketIdentity">
        <h3 id={titleId}>
          {value.ticket.ref.id} {value.ticket.title}
        </h3>
        <span>
          <span className="k">state </span>
          {value.ticket.state ?? '(unknown)'}
        </span>
        <span>
          <span className="k">labels </span>
          {value.ticket.labels.join(', ') || 'none'}
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

      <section className="section bodySection">
        <h3>Body</h3>
        <MarkdownBodyEditor
          value={draft.body}
          disabled={disabled}
          onChange={(body) => onEdit({ ...draft, body })}
        />
      </section>

      {promotable && (
        <div className="controls promoteControl">
          <button type="button" className="btn" disabled={disabled} onClick={onPromote}>
            <kbd>p</kbd> Move to {readyState}
          </button>
        </div>
      )}

      <form
        className="composer ticketFields"
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
          <span>labels, complete replacement</span>
          <input
            value={draft.labels.join(', ')}
            onChange={(event) => onEdit({ ...draft, labels: parseLabels(event.target.value) })}
          />
        </label>
        {dirty && (
          <div className="controls">
            <button type="submit" className="btn" disabled={disabled}>
              Save changes
            </button>
          </div>
        )}
      </form>

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
        <button type="button" className="word" onClick={onNew}>
          new ticket
        </button>
      </div>
      <Rule />
    </article>
  )
}
