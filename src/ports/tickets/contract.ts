import { describe, expect, test } from 'bun:test'
import type {
  DependencyState,
  Ticket,
  TicketCreateOptions,
  TicketDraft,
  TicketSource,
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
  /** Called before a reserved external id is used, so live cleanup remains
   * possible even if creation commits and the adapter call then fails. */
  beforeCreate?: (idempotencyKey: string) => Promise<void> | void
  /** Fixture-only bookkeeping, such as attaching a Linear issue to the
   * explicitly configured scratch project. */
  afterCreate?: (
    ticket: Ticket,
    idempotencyKey: string,
  ) => Promise<void> | void
  cleanup?: () => Promise<void>
}

export type TicketSourceContractFactory =
  () => Promise<TicketSourceContractHarness>

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
        expect(initiallyReady.some((ticket) => ticket.ref.id === created.ref.id)).toBe(
          true,
        )

        await harness.source.transition(created.ref.id, harness.states.completed)
        expect((await harness.source.get(created.ref.id))?.state).toBe(
          harness.states.completed,
        )
        const stillReady = await harness.source.listReady({
          state: harness.states.ready,
        })
        expect(stillReady.some((ticket) => ticket.ref.id === created.ref.id)).toBe(
          false,
        )
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
        expect(
          await harness.source.dependencyStates(expected.map((state) => state.id)),
        ).toEqual(expected)
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
        const matching = (
          await harness.source.listReady({ state: harness.states.ready })
        ).filter((ticket) => ticket.ref.id === first.ref.id)
        expect(matching).toHaveLength(1)
      })
    })
  })
}
