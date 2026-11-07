import { describe, expect, test } from 'bun:test'
import { queuedTickets, URGENT_MARK } from './queue'

const t = (id: string, priority?: 'urgent' | 'normal') => ({
  id,
  ...(priority ? { priority } : {}),
})

describe('queuedTickets', () => {
  test('orders urgent first, then normal, each in source order', () => {
    const rows = queuedTickets([t('N1'), t('U1', 'urgent'), t('N2'), t('U2', 'urgent')])
    expect(rows.map((row) => row.ticket.id)).toEqual(['U1', 'U2', 'N1', 'N2'])
    expect(rows.map((row) => row.urgent)).toEqual([true, true, false, false])
  })

  test('keeps an all-normal or empty list in order', () => {
    expect(queuedTickets([])).toEqual([])
    const rows = queuedTickets([t('A'), t('B', 'normal'), t('C')])
    expect(rows.map((row) => row.ticket.id)).toEqual(['A', 'B', 'C'])
  })

  test('reads explicit normal and absent priority as not urgent', () => {
    expect(queuedTickets([t('A', 'normal'), t('B')]).map((row) => row.urgent)).toEqual([
      false,
      false,
    ])
  })

  test('is stable over a page the server already ordered', () => {
    const page = [t('U1', 'urgent'), t('U2', 'urgent'), t('N1'), t('N2')]
    const once = queuedTickets(page).map((row) => row.ticket)
    expect(queuedTickets(once).map((row) => row.ticket.id)).toEqual(['U1', 'U2', 'N1', 'N2'])
  })

  test('names the mark once for every frontend', () => {
    expect(URGENT_MARK).toBe('URGENT')
  })
})
