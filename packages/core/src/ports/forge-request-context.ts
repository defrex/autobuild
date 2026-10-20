import { AsyncLocalStorage } from 'node:async_hooks'
import type { ForgeRequestContext } from './forge-failure'
const context = new AsyncLocalStorage<ForgeRequestContext>()
export const forgeRequestContext = (): ForgeRequestContext => context.getStore() ?? {}
export function withForgeRequestContext<T>(value: ForgeRequestContext, work: () => T): T {
  return context.run(value, work)
}

/** Kernel-only per-operation gate, inherited by all wire calls in that operation. */
const gates = new AsyncLocalStorage<{
  before: () => Promise<void>
  failed: (error: unknown) => Promise<void>
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

/** Observers from another concurrent operation cannot prove this probe succeeded. */
export const forgeRequestGateActive = (gate: object): boolean => gates.getStore() === gate

/** Internal scheduling deferral; adapters must not turn it into a policy refusal. */
export class ForgeRequestDeferred extends Error {}
