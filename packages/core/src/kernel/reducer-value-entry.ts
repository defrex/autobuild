/**
 * The value-read entry every registered reducer is served through, built
 * without the complete catalog. `reducer-registry.ts` builds `REDUCERS` with
 * `valueReadEntry`, and `reducer-value-index.ts` builds the selectively loaded
 * registrations with it, so both produce identical entries.
 */
import { z } from 'zod'
import { phaseSchema } from '../ontology'
import { validateAccumulator, encodeReducerValue } from '../store/reducer-value-validation'
import type { ValueCatalogEntry } from '../store/reducer-value-read'
import type { IncrementalReducer } from './incremental'

export interface RegisteredReducer {
  valueRead: ValueCatalogEntry | { excluded: string }
  // biome-ignore lint/suspicious/noExplicitAny: the registry is heterogeneous
  reducer: IncrementalReducer<any, any, any>
  /** The whole-array functions (or private methods) this reducer backs. */
  covers: readonly string[]
}

/** Qualification concerns the existing finished contract, including absence. */
export const valueExclusions: Record<string, string> = {
  dispatchFrontend: 'returns a list of raw repository journal events',
  journalView: 'returns a list of raw repository journal events',
  repositoryStateEvents: 'returns a list of raw repository journal events',
  session: 'consumes operator-session logs rather than build or repository events',
  publicationState: 'finished value contains executable selector functions',
  logIndex: 'finished value contains Maps and Sets',
  hostedPrAttachments: 'finished value is a Map',
  ...Object.fromEntries(
    [
      'summaryBoundary',
      'ticketSourceHealth',
      'frozenPrImageHost',
      'publishedBranchHead',
      'verifyDiffBase',
      'recordedBaseSha',
      'baseBranch',
      'provisionMarker',
      'recoveryCheckpoint',
    ].map((name) => [name, 'finished contract can return top-level undefined, which is not JSON']),
  ),
}
export const repositoryValues = new Set([
  'dispatchPlacement',
  'ticketPreparation',
  'ticketHandbacks',
  'ticketStarts',
  'ticketMigrations',
  'forgeHealthValue',
  'repositoryReadFacts',
  'dispatchUpgrade',
  'dispatcherRunFacts',
  'repositoryAttention',
  'effectiveConfig',
  'harvestDelegation',
  'harvest',
  'dispatchSettings',
  'dispatchStatus',
  'sandboxStates',
  'openHarvestExecutions',
  'hostedHarvestAuthority',
  'openTick',
  'autoMergeDefault',
])
export const noArgs = z.object({}).strict()
const run = z.object({ run: z.string().min(1) }).strict()
/** Arguments of the parameterized reducers; their `create` functions stay with
 * the reducer modules that construct them. */
export const parameterizedArgs: Record<string, z.ZodType> = {
  terminalGuard: z
    .object({ phase: phaseSchema, round: z.number().int(), session: z.string().min(1) })
    .strict(),
  dispatchStatus: run,
  dispatcherRunFacts: run,
  openTick: run,
  dispatchFailureBudget: z.object({ infrastructureOwnsWorkspace: z.boolean() }).strict(),
  phaseFailures: z.object({ phase: phaseSchema, round: z.number().int().nonnegative() }).strict(),
}

/** One registered reducer's value-read entry. */
export function valueReadEntry(
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: the registry is heterogeneous
  reducer: IncrementalReducer<any, any, any>,
  options: Partial<Pick<ValueCatalogEntry, 'create' | 'adapt'>> = {},
): RegisteredReducer['valueRead'] {
  const excluded = valueExclusions[name]
  if (excluded) return { excluded }
  return {
    scope: repositoryValues.has(name) ? 'repo' : 'build',
    args: parameterizedArgs[name] ?? noArgs,
    validate: (state: unknown) => validateAccumulator(name, state),
    value: encodeReducerValue,
    adapt: options.adapt ?? ((events) => events),
    create: options.create ?? (() => reducer),
  }
}
