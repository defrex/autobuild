import { AsyncLocalStorage } from 'node:async_hooks'
import type { ForgeFailure, ForgeRequestContext } from './forge-failure'
const context = new AsyncLocalStorage<ForgeRequestContext>()
export const forgeRequestContext = (): ForgeRequestContext => context.getStore() ?? {}
export function withForgeRequestContext<T>(value: ForgeRequestContext, work: () => T): T {
  return context.run(value, work)
}

/** Which remembered exhaustion an adapter would pre-empt a request for: the
 * quota it names and the adapter's identity for that piece of evidence, new
 * for every exhausted observation. */
export type ForgeExhaustionEvidence = { quota: string; seq: number }

/** Kernel-only per-operation gate, inherited by all wire calls in that operation. */
const gates = new AsyncLocalStorage<{
  before: () => Promise<void>
  failed: (error: unknown) => Promise<void>
  /** An adapter remembers `failure`'s quota as exhausted: `'probe'` lets the
   * request reach the provider anyway (an explicit override of evidence the
   * kernel already recorded), `'defer'` has the adapter throw `failure`. */
  exhausted?: (
    failure: ForgeFailure,
    evidence: ForgeExhaustionEvidence,
  ) => Promise<'defer' | 'probe'>
}>()
export function withForgeRequestGate<T>(
  gate: NonNullable<ReturnType<typeof gates.getStore>>,
  work: () => T,
): T {
  return gates.run(gate, work)
}
export async function guardedForgeRequest<T>(work: () => Promise<T>): Promise<T> {
  const gate = gates.getStore()
  await gate?.before()
  try {
    return await work()
  } catch (error) {
    await gate?.failed(error)
    throw error
  }
}

/** Kernel-only seam, never exposed to plugins: whether a request the adapter
 * would pre-empt for remembered quota exhaustion may go out as a probe.
 * Without a gate, or a gate without the hook, the answer is `'defer'`. */
export async function forgeRequestExhausted(
  failure: ForgeFailure,
  evidence: ForgeExhaustionEvidence,
): Promise<'defer' | 'probe'> {
  return (await gates.getStore()?.exhausted?.(failure, evidence)) ?? 'defer'
}

/** Observers from another concurrent operation cannot prove this probe succeeded. */
export const forgeRequestGateActive = (gate: object): boolean => gates.getStore() === gate

/** Internal scheduling deferral; adapters must not turn it into a policy refusal. */
export class ForgeRequestDeferred extends Error {}
