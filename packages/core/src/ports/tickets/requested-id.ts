/** Requested-id policies shared by adapter writes and migration preflight. */
export interface RequestedIdPolicy {
  preserve(id: string): string | undefined
  allocate(occupied: string[]): string
}

export function validateFileTicketId(id: string): string {
  if (!id || id === '.' || /[/\\\0]/.test(id) || id.includes('..'))
    throw new Error(`file ticket source: invalid ticket id "${id}"`)
  return id
}

export const fileRequestedIds: RequestedIdPolicy = {
  preserve: validateFileTicketId,
  allocate(occupied) {
    let n = 1
    while (occupied.includes(`file-${n}`)) n++
    return `file-${n}`
  },
}

export const MAX_TICKET_NUMBER = 9223372036854775807n
export function hostedRequestedIds(teamKey: string): RequestedIdPolicy {
  const numberOf = (id: string): bigint | undefined => {
    if (!id.startsWith(`${teamKey}-`)) return undefined
    const suffix = id.slice(teamKey.length + 1)
    if (!/^[1-9][0-9]*$/.test(suffix)) return undefined
    const n = BigInt(suffix)
    if (n > MAX_TICKET_NUMBER) throw new Error(`ticket number exceeds PostgreSQL bigint: ${id}`)
    return n
  }
  return {
    preserve(id) {
      return numberOf(id) === undefined ? undefined : id
    },
    allocate(occupied) {
      let max = 0n
      for (const id of occupied) {
        const n = numberOf(id)
        if (n !== undefined && n > max) max = n
      }
      if (max === MAX_TICKET_NUMBER) throw new Error('ticket numbers exhausted')
      return `${teamKey}-${max + 1n}`
    },
  }
}
