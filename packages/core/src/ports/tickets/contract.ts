import { createTicket, updateTicket, moveTicket, changeBlockers } from './operations'
import { normalizeIssueLinks, TicketIssueLinksUnsupported } from './issue-links'
import { TicketPriorityUnsupported } from './priority'
import { compatibleTicketSource } from './tree'
import { TicketRevisionConflict } from './revision'
import { describe, expect, test } from 'bun:test'
import type {
  DependencyState,
  IssueLink,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketSource,
  TicketUpdate,
  TicketCriteria,
  TicketPage,
} from '../types'

/** Shared assertion also used by negative controls for declared capabilities. */
export async function assertTicketPage(
  source: TicketSource,
  criteria: TicketCriteria,
  page: TicketPage,
  full: Awaited<ReturnType<TicketSource['listReady']>>,
): Promise<void> {
  const actual = await source.listPage!(criteria, page)
  const ordered = page.order === 'newest' ? [...full.tickets].reverse() : full.tickets
  const offset = page.offset ?? 0
  expect(actual).toEqual({
    tickets: ordered.slice(offset, offset + page.limit),
    diagnostics: full.diagnostics,
    total: full.tickets.length,
  })
}

/** Shared assertion also used by negative controls: a declared targeted
 * listing holds exactly the exhaustive listing's tickets targeting the node. */
export async function assertTargetingListing(source: TicketSource, nodeId: string): Promise<void> {
  const ids = (tickets: Ticket[]) => tickets.map((ticket) => ticket.ref.id).sort()
  const all = await source.listAll!()
  const targeting = await source.listTargeting!(nodeId)
  expect(ids(targeting.tickets)).toEqual(
    ids(all.tickets.filter((ticket) => ticket.target === nodeId)),
  )
}

/** Lifecycle names supplied by an adapter's contract fixture. */
export interface TicketSourceContractStates {
  /** A state from which the fixture's source can claim a ticket. */
  ready: string
  /** The state configured as the source's claim destination. */
  claimed: string
  /** A state the source considers resolved for dependency checks. */
  completed: string
}

export interface TicketSourceContractHarness {
  source: TicketSource
  states: TicketSourceContractStates
  /** A fixture label known to be writable in this source/team. */
  editableLabel: string
  /** Set false when a forwarding source declares `countStates` but its
   * backend cannot answer it (the hosted client over a backend without counts). */
  stateCounts?: boolean
  /** Allocate a label name that does not yet exist in the source. Live
   * providers may use this seam to track provider-side labels for cleanup. */
  freshLabel?: (purpose: string) => Promise<string> | string
  /** Called before a reserved external id is used, so live cleanup remains
   * possible even if creation commits and the adapter call then fails. */
  beforeCreate?: (idempotencyKey: string) => Promise<void> | void
  /** Fixture-only bookkeeping, such as attaching a Linear issue to the
   * explicitly configured scratch project. */
  afterCreate?: (ticket: Ticket, idempotencyKey: string) => Promise<void> | void
  cleanup?: () => Promise<void>
  /** Links a source reports on every ticket without being asked, such as a
   * GitHub issue's own `closes` link. They are expected beside the written
   * links and stay when the written links are cleared. */
  intrinsicIssueLinks?: (ticket: Ticket) => IssueLink[]
}

export type TicketSourceContractFactory = () => Promise<TicketSourceContractHarness>

/** Shared live-safe fixtures. UUID suffixes prevent collisions in scratch
 * providers while keeping failures recognizable to an operator. */
export const CONTRACT_TICKET_BODY =
  '# Port contract fixture\n\nCreated by the Autobuild TicketSource contract suite.\n'

export function contractTicketTitle(purpose: string): string {
  return `[ab contract] ${purpose} ${crypto.randomUUID()}`
}

export function contractIdempotencyKey(): string {
  return crypto.randomUUID()
}

export function contractLabelName(purpose: string): string {
  const slug = purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  return `ab-contract-${slug}-${suffix}`
}

async function freshLabel(harness: TicketSourceContractHarness, purpose: string): Promise<string> {
  return (await harness.freshLabel?.(purpose)) ?? contractLabelName(purpose)
}

/** `state` is optional per source; when present it names the ticket's own
 * state. Returns the remaining facts for exact comparison. */
async function dependencyFacts(
  harness: TicketSourceContractHarness,
  ids: string[],
): Promise<DependencyState[]> {
  const states = await harness.source.dependencyStates(ids)
  for (const dependency of states) {
    if (dependency.state === undefined) continue
    expect(dependency.exists).toBe(true)
    expect<string | undefined>(dependency.state).toBe(
      (await harness.source.get(dependency.id))?.state,
    )
  }
  return states.map(({ state: _state, ...facts }) => facts)
}

async function withTicketSource(
  factory: TicketSourceContractFactory,
  run: (harness: TicketSourceContractHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory()
  let failure: unknown
  try {
    await run(harness)
  } catch (error) {
    failure = error
  }

  try {
    await harness.cleanup?.()
  } catch (cleanupError) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, cleanupError],
        'TicketSource contract assertion and cleanup both failed',
      )
    }
    throw cleanupError
  }
  if (failure !== undefined) throw failure
}

/** First-use time per contract creation key, so a retry passes the same
 * `idempotencyKeyReservedAt` as the attempt that first used the key. */
const contractKeyReservations = new Map<string, string>()

/** Every contract-created ticket carries a UUID-v4 reservation. Linear uses
 * it as the issue id; file and fake adapters treat the same value opaquely. */
async function createTracked(
  harness: TicketSourceContractHarness,
  draft: TicketDraft,
  opts: TicketCreateOptions = {},
): Promise<Ticket> {
  const idempotencyKey = opts.idempotencyKey ?? contractIdempotencyKey()
  let idempotencyKeyReservedAt = contractKeyReservations.get(idempotencyKey)
  if (idempotencyKeyReservedAt === undefined) {
    idempotencyKeyReservedAt = new Date().toISOString()
    contractKeyReservations.set(idempotencyKey, idempotencyKeyReservedAt)
  }
  await harness.beforeCreate?.(idempotencyKey)
  const created = await harness.source.create(draft, {
    ...opts,
    idempotencyKey,
    idempotencyKeyReservedAt,
  })
  await harness.afterCreate?.(created, idempotencyKey)
  return created
}

/**
 * Reusable TicketSource semantics. Adapter-specific transport and formatting
 * tests stay beside each implementation; this suite is the common behavioral
 * floor every fake, local adapter, and live provider must run unchanged.
 */
export function describeTicketSourceContract(
  name: string,
  factory: TicketSourceContractFactory,
): void {
  describe(`TicketSource contract: ${name}`, () => {
    test('native pages equal exhaustive listing windows when declared', async () => {
      await withTicketSource(factory, async (harness) => {
        const source = harness.source
        if (!source.listPage) return
        const first = await freshLabel(harness, 'page')
        const second = await freshLabel(harness, 'page-intersection')
        for (let i = 0; i < 5; i++)
          await createTracked(
            harness,
            {
              title: contractTicketTitle('page'),
              body: CONTRACT_TICKET_BODY,
              labels: i % 2 ? [first] : [first, second],
            },
            { state: i === 4 ? harness.states.completed : harness.states.ready },
          )
        for (const criteria of [
          { labels: [first] },
          { state: harness.states.ready, labels: [first] },
          { state: harness.states.completed, labels: [first] },
          { labels: [first, second] },
          { labels: [await freshLabel(harness, 'missing')] },
          { state: harness.states.ready, labels: [] },
        ]) {
          const full = await source.listReady(criteria)
          for (const order of [undefined, 'oldest', 'newest'] as const)
            for (const window of [
              { limit: 2 },
              { limit: 2, offset: 1 },
              { limit: 2, offset: full.tickets.length + 1 },
              { limit: 0 },
            ]) {
              const page = { ...window, ...(order ? { order } : {}) }
              await assertTicketPage(source, criteria, page, full)
            }
        }
      })
    })

    test('bounded state counts agree with listed states when declared', async () => {
      await withTicketSource(factory, async (harness) => {
        const source = harness.source
        if (!source.countStates || !source.listStates || harness.stateCounts === false) return
        await createTracked(
          harness,
          { title: contractTicketTitle('state-counts'), body: CONTRACT_TICKET_BODY },
          { state: harness.states.ready },
        )
        const listed = await source.listStates()
        const ready = listed.find((state) => state.name === harness.states.ready)
        // A forwarding client whose backend cannot enumerate states lists none.
        if (ready === undefined) return
        expect(ready.tickets).toBeGreaterThan(0)
        for (let i = 0; i < listed.length; i += 16) {
          const chunk = listed.slice(i, i + 16)
          expect(await source.countStates(chunk.map((state) => state.name))).toEqual(
            chunk.map(({ name, tickets }) => ({ name, tickets })),
          )
        }
        const flipped = harness.states.ready.toUpperCase()
        const unique =
          listed.filter((state) => state.name.toLowerCase() === flipped.toLowerCase()).length === 1
        if (unique && flipped !== harness.states.ready)
          expect(await source.countStates([flipped])).toEqual([
            { name: harness.states.ready, tickets: ready.tickets },
          ])
        expect(await source.countStates([`missing-${crypto.randomUUID()}`])).toEqual([])
      })
    })

    test('optional integration tree metadata preserves graph invariants', async () => {
      await withTicketSource(factory, async (harness) => {
        const source = harness.source
        if (!source.integrationTree) return
        expect(typeof source.listAll).toBe('function')
        const node = await createTracked(harness, {
          title: contractTicketTitle('node'),
          body: CONTRACT_TICKET_BODY,
          kind: 'node',
        })
        const child = await createTracked(harness, {
          title: contractTicketTitle('child'),
          body: CONTRACT_TICKET_BODY,
          target: node.ref.id,
        })
        expect((await source.get(node.ref.id))?.kind).toBe('node')
        expect((await source.get(child.ref.id))?.target).toBe(node.ref.id)
        expect(
          (await source.listAll!()).tickets.some((ticket) => ticket.ref.id === child.ref.id),
        ).toBe(true)
        await expect(
          source.update(node.ref.id, { kind: 'work', title: 'Must not change' }),
        ).rejects.toThrow()
        expect((await source.get(node.ref.id))?.title).toBe(node.title)
        await expect(source.update(node.ref.id, { target: node.ref.id })).rejects.toThrow()
        const nested = await createTracked(harness, {
          title: contractTicketTitle('nested node'),
          body: CONTRACT_TICKET_BODY,
          kind: 'node',
          target: node.ref.id,
        })
        await source.update(child.ref.id, { target: nested.ref.id })
        expect((await source.get(child.ref.id))?.target).toBe(nested.ref.id)
        await expect(source.update(node.ref.id, { target: nested.ref.id })).rejects.toThrow()
        await source.update(child.ref.id, { target: null })
        await source.update(nested.ref.id, { target: null, kind: 'work' })
        await source.update(node.ref.id, { kind: 'work' })
        expect((await source.get(node.ref.id))?.kind).toBe('work')
      })
    })

    test('a declared targeted listing equals the exhaustive listing filtered by target', async () => {
      await withTicketSource(factory, async (harness) => {
        const source = harness.source
        if (!source.listTargeting) return
        expect(source.integrationTree).toBe(true)
        const node = await createTracked(harness, {
          title: contractTicketTitle('targeted node'),
          body: CONTRACT_TICKET_BODY,
          kind: 'node',
        })
        const open = await createTracked(harness, {
          title: contractTicketTitle('targeted child'),
          body: CONTRACT_TICKET_BODY,
          target: node.ref.id,
        })
        await createTracked(
          harness,
          {
            title: contractTicketTitle('resolved child'),
            body: CONTRACT_TICKET_BODY,
            target: node.ref.id,
          },
          { state: harness.states.completed },
        )
        await createTracked(harness, {
          title: contractTicketTitle('untargeted'),
          body: CONTRACT_TICKET_BODY,
        })
        await assertTargetingListing(source, node.ref.id)
        expect(
          (await source.listTargeting(node.ref.id)).tickets.map((ticket) => ticket.ref.id),
        ).toContain(open.ref.id)
        await assertTargetingListing(source, open.ref.id)
        expect((await source.listTargeting(contractIdempotencyKey())).tickets).toEqual([])
      })
    })

    test('issue links persist when declared and are refused otherwise', async () => {
      await withTicketSource(factory, async (harness) => {
        const source = harness.source
        const ready = harness.states.ready
        if (!source.issueLinks) {
          const title = contractTicketTitle('refused issue links')
          const refusedCreate = await createTicket(source, {
            title,
            body: CONTRACT_TICKET_BODY,
            state: ready,
            issueLinks: [{ issue: 1, intent: 'closes' }],
          }).catch((error: unknown) => error)
          expect(refusedCreate).toBeInstanceOf(TicketIssueLinksUnsupported)
          expect((refusedCreate as TicketIssueLinksUnsupported).source).toBe(source.name)
          expect(
            (await source.listReady({ state: ready })).tickets.some((t) => t.title === title),
          ).toBe(false)
          const created = await createTracked(
            harness,
            { title: contractTicketTitle('unlinked'), body: CONTRACT_TICKET_BODY },
            { state: ready },
          )
          const refusedUpdate = await updateTicket(source, created.ref.id, {
            issueLinks: [],
          }).catch((error: unknown) => error)
          expect(refusedUpdate).toBeInstanceOf(TicketIssueLinksUnsupported)
          expect((refusedUpdate as TicketIssueLinksUnsupported).source).toBe(source.name)
          expect((await source.get(created.ref.id))?.revision).toBe(created.revision)
          return
        }
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('issue links'),
            body: CONTRACT_TICKET_BODY,
            issueLinks: [
              { issue: 2, intent: 'refs' },
              { issue: 1, intent: 'closes' },
            ],
          },
          { state: ready },
        )
        const id = created.ref.id
        const intrinsic = harness.intrinsicIssueLinks?.(created) ?? []
        // Written links beside the source's own; none at all reads as absent.
        const expected = (written: IssueLink[]): IssueLink[] | undefined => {
          const all = normalizeIssueLinks([...written, ...intrinsic])
          return all.length > 0 ? all : undefined
        }
        const given: IssueLink[] = [
          { issue: 1, intent: 'closes' },
          { issue: 2, intent: 'refs' },
        ]
        const sorted = expected(given)
        expect(created.issueLinks).toEqual(sorted)
        expect((await source.get(id))?.issueLinks).toEqual(sorted)
        expect(
          (await source.listReady({ state: ready })).tickets.find((t) => t.ref.id === id)
            ?.issueLinks,
        ).toEqual(sorted)
        if (source.listAll)
          expect((await source.listAll()).tickets.find((t) => t.ref.id === id)?.issueLinks).toEqual(
            sorted,
          )

        await source.update(id, { issueLinks: [{ issue: 7, intent: 'refs' }] })
        const replaced = await source.get(id)
        expect(replaced?.issueLinks).toEqual(expected([{ issue: 7, intent: 'refs' }]))
        expect(replaced?.revision).not.toBe(created.revision)

        await source.update(id, { title: `${created.title} renamed` })
        expect((await source.get(id))?.issueLinks).toEqual(expected([{ issue: 7, intent: 'refs' }]))
        await source.update(id, { title: created.title, issueLinks: given })
        const restored = (await source.get(id))?.revision
        await source.update(id, { issueLinks: given })
        expect((await source.get(id))?.revision).toBe(restored)

        await source.update(id, { issueLinks: [] })
        const cleared = await source.get(id)
        if (intrinsic.length > 0) expect(cleared?.issueLinks).toEqual(expected([]))
        else {
          expect(cleared?.issueLinks).toBeUndefined()
          expect(cleared && 'issueLinks' in cleared).toBe(false)
        }

        if (source.mutateIfRevision) {
          await source.mutateIfRevision(id, cleared!.revision, {
            kind: 'update',
            patch: { issueLinks: [{ issue: 3, intent: 'closes' }] },
          })
          expect((await source.get(id))?.issueLinks).toEqual(
            expected([{ issue: 3, intent: 'closes' }]),
          )
        }
      })
    })

    test('urgent priority persists when declared and is refused otherwise', async () => {
      await withTicketSource(factory, async (harness) => {
        const source = harness.source
        const ready = harness.states.ready
        if (!source.priority) {
          const title = contractTicketTitle('refused priority')
          const refusedCreate = await createTicket(source, {
            title,
            body: CONTRACT_TICKET_BODY,
            state: ready,
            priority: 'urgent',
          }).catch((error: unknown) => error)
          expect(refusedCreate).toBeInstanceOf(TicketPriorityUnsupported)
          expect((refusedCreate as TicketPriorityUnsupported).source).toBe(source.name)
          expect(
            (await source.listReady({ state: ready })).tickets.some((t) => t.title === title),
          ).toBe(false)
          const created = await createTracked(
            harness,
            { title: contractTicketTitle('normal'), body: CONTRACT_TICKET_BODY },
            { state: ready },
          )
          const refusedUpdate = await updateTicket(source, created.ref.id, {
            priority: 'urgent',
          }).catch((error: unknown) => error)
          expect(refusedUpdate).toBeInstanceOf(TicketPriorityUnsupported)
          expect((refusedUpdate as TicketPriorityUnsupported).source).toBe(source.name)
          if (source.mutateIfRevision) {
            const refusedGuarded = await updateTicket(
              source,
              created.ref.id,
              { priority: 'urgent' },
              false,
              created.revision,
            ).catch((error: unknown) => error)
            expect(refusedGuarded).toBeInstanceOf(TicketPriorityUnsupported)
          }
          const unchanged = await source.get(created.ref.id)
          expect(unchanged?.revision).toBe(created.revision)
          expect(unchanged?.title).toBe(created.title)
          // Normal is the value an unsupported source already holds: a no-op.
          await compatibleTicketSource(source).update(created.ref.id, { priority: 'normal' })
          expect((await source.get(created.ref.id))?.revision).toBe(created.revision)
          return
        }
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('urgent'),
            body: CONTRACT_TICKET_BODY,
            priority: 'urgent',
          },
          { state: ready },
        )
        const id = created.ref.id
        expect(created.priority).toBe('urgent')
        expect((await source.get(id))?.priority).toBe('urgent')
        expect(
          (await source.listReady({ state: ready })).tickets.find((t) => t.ref.id === id)?.priority,
        ).toBe('urgent')
        if (source.listAll)
          expect((await source.listAll()).tickets.find((t) => t.ref.id === id)?.priority).toBe(
            'urgent',
          )

        await source.update(id, { priority: 'normal' })
        const normal = await source.get(id)
        expect(normal && 'priority' in normal).toBe(false)
        expect(normal?.revision).not.toBe(created.revision)

        await source.update(id, { priority: 'urgent' })
        const urgent = await source.get(id)
        expect(urgent?.priority).toBe('urgent')
        // Revisions may be content hashes or counters: only change is required.
        expect(urgent?.revision).not.toBe(normal?.revision)

        if (source.mutateIfRevision) {
          await expect(
            source.mutateIfRevision(id, normal!.revision, {
              kind: 'update',
              patch: { priority: 'normal' },
            }),
          ).rejects.toBeInstanceOf(TicketRevisionConflict)
          expect((await source.get(id))?.priority).toBe('urgent')
          await source.mutateIfRevision(id, urgent!.revision, {
            kind: 'update',
            patch: { priority: 'normal' },
          })
          const cleared = await source.get(id)
          expect(cleared && 'priority' in cleared).toBe(false)
          expect(cleared?.revision).not.toBe(urgent!.revision)
        }
      })
    })

    test('revisions cover mutable content and guarded writes fail closed', async () => {
      await withTicketSource(factory, async (harness) => {
        const source = harness.source
        const created = await createTracked(
          harness,
          { title: contractTicketTitle('revisions'), body: CONTRACT_TICKET_BODY },
          { state: harness.states.ready },
        )
        const id = created.ref.id
        expect(created.revision.trim()).not.toBe('')
        expect((await source.get(id))?.revision).toBe(created.revision)
        expect(
          (await source.listReady({ state: harness.states.ready })).tickets.find(
            (t) => t.ref.id === id,
          )?.revision,
        ).toBe(created.revision)
        if (!source.mutateIfRevision) {
          await expect(
            updateTicket(source, id, { title: 'Never written' }, false, created.revision),
          ).rejects.toThrow('does not support')
          expect((await source.get(id))?.revision).toBe(created.revision)
          return
        }
        let current = created
        for (const patch of [
          { title: contractTicketTitle('renamed') },
          { body: 'Changed body' },
          { labels: [harness.editableLabel] },
        ]) {
          await updateTicket(source, id, patch, false, current.revision)
          const next = (await source.get(id))!
          expect(next.revision).not.toBe(current.revision)
          await expect(updateTicket(source, id, patch, false, current.revision)).rejects.toThrow(
            'current revision',
          )
          expect(await source.get(id)).toEqual(next)
          current = next
        }
        await moveTicket(source, id, harness.states.completed, current.revision)
        const moved = (await source.get(id))!
        expect(moved.revision).not.toBe(current.revision)
        await expect(
          moveTicket(source, id, harness.states.ready, current.revision),
        ).rejects.toThrow('current revision')
        const blocker = await createTracked(harness, {
          title: contractTicketTitle('blocker'),
          body: CONTRACT_TICKET_BODY,
        })
        await changeBlockers(source, id, [blocker.ref.id], 'block', moved.revision)
        const blocked = (await source.get(id))!
        expect(blocked.revision).not.toBe(moved.revision)
        await expect(
          changeBlockers(source, id, [blocker.ref.id], 'unblock', moved.revision),
        ).rejects.toThrow('current revision')
        await changeBlockers(source, id, [blocker.ref.id], 'unblock', blocked.revision)
        expect((await source.get(id))?.revision).not.toBe(blocked.revision)
      })
    })
    test('completion projections agree across create, get, listing, and transitions', async () => {
      await withTicketSource(factory, async (harness) => {
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('completion facts'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        expect(created.resolved).toBe(false)
        for (const state of [harness.states.completed, harness.states.ready]) {
          await harness.source.transition(created.ref.id, state)
          const [dependency] = await harness.source.dependencyStates([created.ref.id])
          expect((await harness.source.get(created.ref.id))?.resolved).toBe(dependency?.resolved)
          const listing = await harness.source.listReady({ state })
          expect(listing.tickets.find((ticket) => ticket.ref.id === created.ref.id)?.resolved).toBe(
            dependency?.resolved,
          )
          expect(dependency?.resolved).toBe(state === harness.states.completed)
        }
      })
    })
    test('create/get round-trips common fields and honors an explicit state', async () => {
      await withTicketSource(factory, async (harness) => {
        const title = contractTicketTitle('round trip')
        const created = await createTracked(
          harness,
          { title, body: CONTRACT_TICKET_BODY, labels: [] },
          { state: harness.states.ready },
        )

        expect(created).toMatchObject({
          ref: { source: harness.source.name, title },
          creationKey: expect.any(String),
          title,
          body: CONTRACT_TICKET_BODY,
          state: harness.states.ready,
          labels: [],
        })
        const detail = await harness.source.get(created.ref.id)
        expect(detail).not.toBeNull()
        // Detail reads may expose structured history absent from write responses.
        const { comments, ...record } = detail!
        const { comments: createdComments, ...createdRecord } = created
        expect(record).toEqual(createdRecord)
        if (comments !== undefined) expect(comments).toEqual(createdComments ?? [])
      })
    })

    test('create accepts a previously unknown label and round-trips it through get', async () => {
      await withTicketSource(factory, async (harness) => {
        const label = await freshLabel(harness, 'create')
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('fresh create label'),
            body: CONTRACT_TICKET_BODY,
            labels: [label],
          },
          { state: harness.states.ready },
        )

        expect(created.labels).toEqual([label])
        expect((await harness.source.get(created.ref.id))?.labels).toEqual([label])
      })
    })

    test('update accepts a previously unknown label and round-trips it through get', async () => {
      await withTicketSource(factory, async (harness) => {
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('fresh update label'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        const label = await freshLabel(harness, 'update')

        await harness.source.update(created.ref.id, { labels: [label] })

        expect((await harness.source.get(created.ref.id))?.labels).toEqual([label])
      })
    })

    test('concurrent writes safely share one previously unknown label', async () => {
      await withTicketSource(factory, async (harness) => {
        const first = await createTracked(
          harness,
          {
            title: contractTicketTitle('concurrent label first'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        const second = await createTracked(
          harness,
          {
            title: contractTicketTitle('concurrent label second'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        const label = await freshLabel(harness, 'concurrent')

        await Promise.all([
          harness.source.update(first.ref.id, { labels: [label] }),
          harness.source.update(second.ref.id, { labels: [label] }),
        ])

        expect((await harness.source.get(first.ref.id))?.labels).toEqual([label])
        expect((await harness.source.get(second.ref.id))?.labels).toEqual([label])
      })
    })

    test('get returns null for a valid nonexistent id', async () => {
      await withTicketSource(factory, async ({ source }) => {
        expect(await source.get(contractIdempotencyKey())).toBeNull()
      })
    })

    test('claim succeeds once, rejects an immediate repeat, and resets after Ready handback', async () => {
      await withTicketSource(factory, async (harness) => {
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('claim'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )

        expect(await harness.source.claim(created.ref.id)).toBe(true)
        expect(await harness.source.claim(created.ref.id)).toBe(false)
        await harness.source.transition(created.ref.id, harness.states.ready)
        expect(await harness.source.claim(created.ref.id)).toBe(true)
      })
    })

    test('claim rejects a completed ticket without reopening it', async () => {
      await withTicketSource(factory, async (harness) => {
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('completed claim'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.completed },
        )

        expect(await harness.source.claim(created.ref.id)).toBe(false)
        expect((await harness.source.get(created.ref.id))?.state).toBe(harness.states.completed)
      })
    })

    test('comment accepts known tickets and rejects unknown tickets', async () => {
      await withTicketSource(factory, async (harness) => {
        const created = await createTracked(
          harness,
          { title: contractTicketTitle('comment'), body: CONTRACT_TICKET_BODY },
          { state: harness.states.ready },
        )
        await expect(
          harness.source.comment(created.ref.id, 'contract comment'),
        ).resolves.toBeUndefined()
        const unknown = contractIdempotencyKey()
        await expect(harness.source.comment(unknown, 'missing')).rejects.toThrow(unknown)
      })
    })

    test('transition is visible through get and state-filtered listReady', async () => {
      await withTicketSource(factory, async (harness) => {
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('transition'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        const initiallyReady = await harness.source.listReady({
          state: harness.states.ready,
        })
        expect(initiallyReady.diagnostics).toEqual([])
        expect(initiallyReady.tickets.some((ticket) => ticket.ref.id === created.ref.id)).toBe(true)

        await harness.source.transition(created.ref.id, harness.states.completed)
        expect((await harness.source.get(created.ref.id))?.state).toBe(harness.states.completed)
        const stillReady = await harness.source.listReady({
          state: harness.states.ready,
        })
        expect(stillReady.diagnostics).toEqual([])
        expect(stillReady.tickets.some((ticket) => ticket.ref.id === created.ref.id)).toBe(false)
      })
    })

    test('dependencyStates covers requested ids in order with native resolution and blockers', async () => {
      await withTicketSource(factory, async (harness) => {
        const unresolved = await createTracked(
          harness,
          {
            title: contractTicketTitle('unresolved dependency'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        const completed = await createTracked(
          harness,
          {
            title: contractTicketTitle('completed dependency'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.completed },
        )
        expect(completed.resolved).toBe(true)
        expect(unresolved.resolved).toBe(false)
        const dependent = await createTracked(
          harness,
          {
            title: contractTicketTitle('declared blocker'),
            body: CONTRACT_TICKET_BODY,
            blockedBy: [unresolved.ref.id],
          },
          { state: harness.states.ready },
        )
        const unknown = contractIdempotencyKey()

        const expected: DependencyState[] = [
          { id: unknown, exists: false, resolved: false, blockedBy: [] },
          {
            id: dependent.ref.id,
            exists: true,
            resolved: false,
            blockedBy: [unresolved.ref.id],
          },
          { id: completed.ref.id, exists: true, resolved: true, blockedBy: [] },
          { id: unresolved.ref.id, exists: true, resolved: false, blockedBy: [] },
        ]
        expect(
          await dependencyFacts(
            harness,
            expected.map((state) => state.id),
          ),
        ).toEqual(expected)
      })
    })

    test('partial updates replace only named editable fields and never state or blockers', async () => {
      await withTicketSource(factory, async (harness) => {
        const blocker = await createTracked(
          harness,
          {
            title: contractTicketTitle('update blocker'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        const originalTitle = contractTicketTitle('partial update')
        const created = await createTracked(
          harness,
          {
            title: originalTitle,
            body: CONTRACT_TICKET_BODY,
            labels: [harness.editableLabel],
            blockedBy: [blocker.ref.id],
          },
          { state: harness.states.ready },
        )

        const replacementBody = `${CONTRACT_TICKET_BODY}\nUpdated body.\n`
        await harness.source.update(created.ref.id, { body: replacementBody })
        expect(await harness.source.get(created.ref.id)).toMatchObject({
          ref: { title: originalTitle },
          title: originalTitle,
          body: replacementBody,
          state: harness.states.ready,
          labels: [harness.editableLabel],
          blockedBy: [blocker.ref.id],
        })

        const replacementTitle = contractTicketTitle('renamed')
        await harness.source.update(created.ref.id, { title: replacementTitle })
        expect(await harness.source.get(created.ref.id)).toMatchObject({
          ref: { title: replacementTitle },
          title: replacementTitle,
          body: replacementBody,
          state: harness.states.ready,
          labels: [harness.editableLabel],
          blockedBy: [blocker.ref.id],
        })

        // An explicit empty list is a replacement, not omission.
        await harness.source.update(created.ref.id, { labels: [] })
        expect(await harness.source.get(created.ref.id)).toMatchObject({
          title: replacementTitle,
          body: replacementBody,
          state: harness.states.ready,
          labels: [],
          blockedBy: [blocker.ref.id],
        })
        expect(await dependencyFacts(harness, [created.ref.id])).toEqual([
          {
            id: created.ref.id,
            exists: true,
            resolved: false,
            blockedBy: [blocker.ref.id],
          },
        ])
      })
    })

    test('update rejects empty/unknown/state patches without changing the ticket', async () => {
      await withTicketSource(factory, async (harness) => {
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('strict update'),
            body: CONTRACT_TICKET_BODY,
            labels: [harness.editableLabel],
          },
          { state: harness.states.ready },
        )
        const before = await harness.source.get(created.ref.id)

        await expect(harness.source.update(created.ref.id, {})).rejects.toThrow('at least one')
        await expect(
          harness.source.update(created.ref.id, {
            state: harness.states.completed,
          } as unknown as TicketUpdate),
        ).rejects.toThrow('state')
        expect(await harness.source.get(created.ref.id)).toEqual(before)
      })
    })

    test('update failures name unknown tickets and blank required fields and are atomic', async () => {
      await withTicketSource(factory, async (harness) => {
        const created = await createTracked(
          harness,
          {
            title: contractTicketTitle('required update fields'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        const before = await harness.source.get(created.ref.id)

        for (const [field, patch] of [
          ['title', { title: '   ' }],
          ['body', { body: '\n\t' }],
        ] as const) {
          await expect(harness.source.update(created.ref.id, patch)).rejects.toThrow(field)
          expect(await harness.source.get(created.ref.id)).toEqual(before)
        }

        const unknown = contractIdempotencyKey()
        await expect(
          harness.source.update(unknown, { title: contractTicketTitle('unknown') }),
        ).rejects.toThrow(unknown)
        expect(await harness.source.get(created.ref.id)).toEqual(before)
      })
    })

    test('blocker add/remove round-trips through get and dependencyStates and retries are no-ops', async () => {
      await withTicketSource(factory, async (harness) => {
        const blocker = await createTracked(
          harness,
          {
            title: contractTicketTitle('post-create blocker'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        const dependent = await createTracked(
          harness,
          {
            title: contractTicketTitle('post-create dependent'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )

        await harness.source.addBlocker(dependent.ref.id, blocker.ref.id)
        await harness.source.addBlocker(dependent.ref.id, blocker.ref.id)
        expect((await harness.source.get(dependent.ref.id))?.blockedBy).toEqual([blocker.ref.id])
        expect(await dependencyFacts(harness, [dependent.ref.id])).toEqual([
          {
            id: dependent.ref.id,
            exists: true,
            resolved: false,
            blockedBy: [blocker.ref.id],
          },
        ])

        await harness.source.removeBlocker(dependent.ref.id, blocker.ref.id)
        await harness.source.removeBlocker(dependent.ref.id, blocker.ref.id)
        // Removing an unrelated/missing blocker has the same intended state.
        await harness.source.removeBlocker(dependent.ref.id, contractIdempotencyKey())
        expect((await harness.source.get(dependent.ref.id))?.blockedBy).toBeUndefined()
        expect(await dependencyFacts(harness, [dependent.ref.id])).toEqual([
          {
            id: dependent.ref.id,
            exists: true,
            resolved: false,
            blockedBy: [],
          },
        ])
      })
    })

    test('addBlocker rejects self-blocks and unknown blockers without changing dependencies', async () => {
      await withTicketSource(factory, async (harness) => {
        const dependent = await createTracked(
          harness,
          {
            title: contractTicketTitle('invalid blocker'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )

        await expect(harness.source.addBlocker(dependent.ref.id, dependent.ref.id)).rejects.toThrow(
          dependent.ref.id,
        )
        const missing = contractIdempotencyKey()
        await expect(harness.source.addBlocker(dependent.ref.id, missing)).rejects.toThrow(missing)
        expect((await harness.source.get(dependent.ref.id))?.blockedBy).toBeUndefined()
      })
    })

    test('blocker writes require the target ticket and name it when unknown', async () => {
      await withTicketSource(factory, async (harness) => {
        const blocker = await createTracked(
          harness,
          {
            title: contractTicketTitle('known blocker'),
            body: CONTRACT_TICKET_BODY,
          },
          { state: harness.states.ready },
        )
        const missingTarget = contractIdempotencyKey()

        await expect(harness.source.addBlocker(missingTarget, blocker.ref.id)).rejects.toThrow(
          missingTarget,
        )
        await expect(harness.source.removeBlocker(missingTarget, blocker.ref.id)).rejects.toThrow(
          missingTarget,
        )
      })
    })

    test('a repeated idempotent create adopts the original instead of duplicating', async () => {
      await withTicketSource(factory, async (harness) => {
        const idempotencyKey = contractIdempotencyKey()
        const originalTitle = contractTicketTitle('idempotent original')
        const first = await createTracked(
          harness,
          { title: originalTitle, body: CONTRACT_TICKET_BODY },
          { state: harness.states.ready, idempotencyKey },
        )
        const retry = await createTracked(
          harness,
          {
            title: contractTicketTitle('idempotent retry must not win'),
            body: 'replacement content must not win\n',
          },
          { state: harness.states.completed, idempotencyKey },
        )

        expect(first.creationKey).toBe(idempotencyKey)
        expect(retry.ref.id).toBe(first.ref.id)
        expect(retry.creationKey).toBe(idempotencyKey)
        expect(retry.title).toBe(originalTitle)
        expect(retry.body).toBe(CONTRACT_TICKET_BODY)
        expect(retry.state).toBe(harness.states.ready)
        const listing = await harness.source.listReady({
          state: harness.states.ready,
        })
        expect(listing.diagnostics).toEqual([])
        const matching = listing.tickets.filter((ticket) => ticket.ref.id === first.ref.id)
        expect(matching).toHaveLength(1)
        expect(matching[0]?.creationKey).toBe(idempotencyKey)
      })
    })
  })
}
