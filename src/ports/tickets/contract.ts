import { describe, expect, test } from 'bun:test'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketSource,
  TicketUpdate,
} from '../types'

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
  /** Called before a reserved external id is used, so live cleanup remains
   * possible even if creation commits and the adapter call then fails. */
  beforeCreate?: (idempotencyKey: string) => Promise<void> | void
  /** Fixture-only bookkeeping, such as attaching a Linear issue to the
   * explicitly configured scratch project. */
  afterCreate?: (ticket: Ticket, idempotencyKey: string) => Promise<void> | void
  cleanup?: () => Promise<void>
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

/** Every contract-created ticket carries a UUID-v4 reservation. Linear uses
 * it as the issue id; file and fake adapters treat the same value opaquely. */
async function createTracked(
  harness: TicketSourceContractHarness,
  draft: TicketDraft,
  opts: TicketCreateOptions = {},
): Promise<Ticket> {
  const idempotencyKey = opts.idempotencyKey ?? contractIdempotencyKey()
  await harness.beforeCreate?.(idempotencyKey)
  const created = await harness.source.create(draft, {
    ...opts,
    idempotencyKey,
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
          title,
          body: CONTRACT_TICKET_BODY,
          state: harness.states.ready,
          labels: [],
        })
        expect(await harness.source.get(created.ref.id)).toEqual(created)
      })
    })

    test('get returns null for a valid nonexistent id', async () => {
      await withTicketSource(factory, async ({ source }) => {
        expect(await source.get(contractIdempotencyKey())).toBeNull()
      })
    })

    test('claim succeeds once and an immediate repeated claim returns false', async () => {
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
        expect(await harness.source.dependencyStates(expected.map((state) => state.id))).toEqual(
          expected,
        )
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
        expect(await harness.source.dependencyStates([created.ref.id])).toEqual([
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
        expect(await harness.source.dependencyStates([dependent.ref.id])).toEqual([
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
        expect(await harness.source.dependencyStates([dependent.ref.id])).toEqual([
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

        expect(retry.ref.id).toBe(first.ref.id)
        expect(retry.title).toBe(originalTitle)
        expect(retry.body).toBe(CONTRACT_TICKET_BODY)
        expect(retry.state).toBe(harness.states.ready)
        const listing = await harness.source.listReady({
          state: harness.states.ready,
        })
        expect(listing.diagnostics).toEqual([])
        const matching = listing.tickets.filter((ticket) => ticket.ref.id === first.ref.id)
        expect(matching).toHaveLength(1)
      })
    })
  })
}
