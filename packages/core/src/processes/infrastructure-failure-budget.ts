import type { AbEvent } from '../events/catalog'

/** Infrastructure retries are re-armed only by a confirmed execution boundary
 * or a retry answer to this policy's own exhaustion escalation. */
export function infrastructureFailureResetSeq(events: readonly AbEvent[]): number {
  const infrastructureEscalations = new Set<string>()
  for (const event of events) {
    if (
      event.type === 'escalation.raised' &&
      event.payload.policyCause === 'infrastructure-failure-limit'
    ) {
      infrastructureEscalations.add(event.payload.id)
    }
  }
  return events.reduce(
    (seq, event) =>
      event.type === 'execution.ended' ||
      (event.type === 'escalation.answered' &&
        event.payload.resolution === 'retry' &&
        infrastructureEscalations.has(event.payload.id))
        ? event.seq
        : seq,
    0,
  )
}
