'use client'

import type { OperatorTicketDetail, OperatorTicketQueue } from 'autobuild/operator-api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import {
  draftFromTicket,
  groupTickets,
  parseLabels,
  reconcileTicketDetail,
  ticketUpdatePatch,
  type TicketDraft,
} from './ticket-view-model'

export function TicketQueue({
  repo,
  onError,
  onOpenBuild,
}: {
  repo: string
  onError: (message?: string) => void
  onOpenBuild: (slug: string) => void
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

  return (
    <section className="ticketQueue" aria-label="Ticket queue">
      <div className="ticketToolbar">
        <label>
          State{' '}
          <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
            <option value="">Ready criteria (default)</option>
            {queue?.states.map((state) => (
              <option key={state}>{state}</option>
            ))}
          </select>
        </label>
        <label>
          Labels (all){' '}
          <input
            value={labelFilter}
            onChange={(event) => setLabelFilter(event.target.value)}
            placeholder="label-a, label-b"
          />
        </label>
      </div>
      {queue?.diagnostics.map((diagnostic) => (
        <p className="warning" key={diagnostic}>
          {diagnostic}
        </p>
      ))}
      <CreateTicket
        states={queue?.states ?? []}
        disabled={pending}
        onCreate={(value) => act(() => api.createTicket(repo, value))}
      />
      {!queue ? (
        <p>Loading tickets…</p>
      ) : (
        <div className="ticketGroups">
          {groupTickets(queue.tickets).map((group) => (
            <section className="ticketGroup" key={group.state}>
              <h2>
                {group.state} <span className="badge">{group.tickets.length}</span>
              </h2>
              {group.tickets.map((ticket) => (
                <button
                  type="button"
                  className={`ticketCard ${selected === ticket.ref.id ? 'selected' : ''}`}
                  key={ticket.ref.id}
                  aria-pressed={selected === ticket.ref.id}
                  onClick={() => {
                    setSelected(ticket.ref.id)
                    setDetail(undefined)
                    setDraft(undefined)
                    setDirty(false)
                    dirtyRef.current = false
                  }}
                >
                  <strong>
                    {ticket.ref.id} · {ticket.title}
                  </strong>
                  <span>{ticket.labels.join(', ') || 'no labels'}</span>
                  {ticket.blockedBy?.length ? (
                    <span>blocked by {ticket.blockedBy.join(', ')}</span>
                  ) : null}
                </button>
              ))}
            </section>
          ))}
          {queue.tickets.length === 0 && <p>No tickets matched.</p>}
        </div>
      )}
      {detail && draft && (
        <TicketDetail
          value={detail}
          draft={draft}
          states={queue?.states ?? []}
          dirty={dirty}
          disabled={pending}
          onEdit={edit}
          onClose={() => setSelected(undefined)}
          onSave={() => {
            const patch = ticketUpdatePatch(detail.ticket, draft)
            if (patch) void act(() => api.updateTicket(repo, detail.ticket.ref.id, patch))
          }}
          onMove={(state) => void act(() => api.moveTicket(repo, detail.ticket.ref.id, state))}
          onBlock={(ids, operation) =>
            void act(() => api.changeBlockers(repo, detail.ticket.ref.id, ids, operation))
          }
          onOpenBuild={onOpenBuild}
        />
      )}
    </section>
  )
}

function CreateTicket({
  states,
  disabled,
  onCreate,
}: {
  states: string[]
  disabled: boolean
  onCreate: (value: {
    title: string
    body: string
    labels?: string[]
    state?: string
    blockedBy?: string[]
  }) => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [labels, setLabels] = useState('')
  const [state, setState] = useState('')
  const [blockers, setBlockers] = useState('')
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Create ticket
      </button>
    )
  return (
    <form
      className="ticketForm"
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
      <h2>Create ticket</h2>
      <label>
        Title
        <input required value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Body
        <textarea required value={body} onChange={(event) => setBody(event.target.value)} />
      </label>
      <label>
        Labels
        <input value={labels} onChange={(event) => setLabels(event.target.value)} />
      </label>
      <label>
        Initial state
        <select value={state} onChange={(event) => setState(event.target.value)}>
          <option value="">Backend default</option>
          {states.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <label>
        Blocked by
        <input value={blockers} onChange={(event) => setBlockers(event.target.value)} />
      </label>
      <div className="controls">
        <button disabled={disabled} type="submit">
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
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
  onOpenBuild: (slug: string) => void
}) {
  const [move, setMove] = useState(value.ticket.state ?? '')
  const [blocker, setBlocker] = useState('')
  return (
    <aside className="detail ticketDetail">
      <div className="detailHead">
        <h2>{value.ticket.ref.id}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        <strong>State:</strong> {value.ticket.state ?? '(unknown)'}
      </p>
      {value.ticket.ref.url && (
        <p>
          <a href={value.ticket.ref.url} target="_blank" rel="noreferrer">
            Open in {value.ticket.ref.source}
          </a>
        </p>
      )}
      {value.build && (
        <p>
          <a
            href={value.build.link}
            onClick={(event) => {
              event.preventDefault()
              onOpenBuild(value.build!.slug)
            }}
          >
            Build {value.build.slug} · {value.build.status}
          </a>
        </p>
      )}
      <label>
        Title
        <input
          value={draft.title}
          onChange={(event) => onEdit({ ...draft, title: event.target.value })}
        />
      </label>
      <label>
        Body
        <textarea
          value={draft.body}
          onChange={(event) => onEdit({ ...draft, body: event.target.value })}
        />
      </label>
      <label>
        Labels (complete replacement)
        <input
          value={draft.labels.join(', ')}
          onChange={(event) => onEdit({ ...draft, labels: parseLabels(event.target.value) })}
        />
      </label>
      <button type="button" disabled={disabled || !dirty} onClick={onSave}>
        Save changes
      </button>
      <section className="markdown">
        <h3>Preview</h3>
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
          {draft.body}
        </ReactMarkdown>
      </section>
      <section>
        <h3>Move</h3>
        <select value={move} onChange={(event) => setMove(event.target.value)}>
          {states.map((state) => (
            <option key={state}>{state}</option>
          ))}
        </select>{' '}
        <button
          type="button"
          disabled={disabled || !move || move === value.ticket.state}
          onClick={() => onMove(move)}
        >
          Move
        </button>
      </section>
      <section>
        <h3>Blockers</h3>
        {value.blockers.length ? (
          <ul>
            {value.blockers.map((item) => (
              <li key={item.id}>
                <strong>{item.id}</strong> ·{' '}
                {!item.exists ? 'missing' : item.resolved ? 'resolved' : 'unresolved'}{' '}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onBlock([item.id], 'unblock')}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>No blockers.</p>
        )}
        <input
          value={blocker}
          onChange={(event) => setBlocker(event.target.value)}
          placeholder="ticket id"
        />{' '}
        <button
          type="button"
          disabled={disabled || !blocker}
          onClick={() => {
            onBlock([blocker], 'block')
            setBlocker('')
          }}
        >
          Add blocker
        </button>
      </section>
    </aside>
  )
}
