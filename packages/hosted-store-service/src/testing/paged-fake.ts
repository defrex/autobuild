import { urgentFirst } from '@defrex/autobuild/hosted-tickets'
import type { FakeTicketSource, TicketSource } from '@defrex/autobuild/plugin-sdk'

/** A fake backend with native paging, as the Postgres store declares it.
 * `FakeTicketSource` lists in insertion order, which is its filing order, so
 * `newest` is the reversed listing and `oldest` is dispatch order. */
export function withPaging<T extends FakeTicketSource>(
  fake: T,
): T & Required<Pick<TicketSource, 'listPage'>> {
  return Object.assign(fake, {
    listPage: async (
      criteria: Parameters<NonNullable<TicketSource['listPage']>>[0],
      page: Parameters<NonNullable<TicketSource['listPage']>>[1],
    ) => {
      const full = await fake.listReady(criteria)
      const ordered =
        page.order === 'newest' ? [...full.tickets].reverse() : urgentFirst(full.tickets)
      const offset = page.offset ?? 0
      return {
        tickets: ordered.slice(offset, offset + page.limit),
        diagnostics: full.diagnostics,
        total: full.tickets.length,
      }
    },
  })
}
