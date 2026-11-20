import { filterKnownEvents } from '../events/compatibility'
import { reducerVersion } from './reducer-identity'
/**
 * The incremental reducer contract: every projection of an event array is a
 * fold plus a final derivation, so its state can be advanced from a previously
 * computed accumulator using only the events newer than it (CLAUDE.md rule 2 —
 * state is a reduction of the log, and any carried accumulator is a cache).
 *
 * The accumulator is plain JSON (no `Map`, `Set`, or class instances), so it
 * survives `JSON.parse(JSON.stringify(acc))` and can be stored and resumed.
 */

export interface IncrementalReducer<Acc, Event, State> {
  /** Derived from `identity` (`reducer-identity.ts`), never edited: a cached
   * accumulator is only valid for the version that wrote it. When `Acc`'s
   * shape or the fold's semantics change, append a revision with
   * `bun tools/reducer-revision.ts <shape|fold> <identity> --reason "…"`. */
  readonly version: number
  /** The name the revision ledger counts revisions against. */
  readonly identity?: string
  /** The accumulator for an empty log. */
  initial(): Acc
  /** Fold events newer than `acc` into a copy of it. Never mutates `acc`. */
  advance(acc: Acc, events: readonly Event[]): Acc
  /** Derive the public state. Returns fresh top-level objects. */
  finish(acc: Acc): State
  /** The whole-array form: `finish(advance(initial(), events))` without the
   * clone. */
  reduce(events: readonly Event[]): State
}

export function cloneAcc<T>(acc: T): T {
  return structuredClone(acc)
}

/** Derive `advance` (clone, then fold in place) and `reduce` from an in-place
 * `fold`. */
export function defineReducer<Acc, Event, State>(def: {
  /** The ledger name of this reducer; see `reducer-identity.ts`. */
  identity: string
  /** Reducers whose accumulators this one carries: their versions add to its own. */
  // biome-ignore lint/suspicious/noExplicitAny: parts are heterogeneous
  parts?: readonly IncrementalReducer<any, any, any>[]
  rawEvents?: boolean
  initial: () => Acc
  fold: (acc: Acc, events: readonly Event[]) => void
  finish: (acc: Acc) => State
}): IncrementalReducer<Acc, Event, State> {
  return {
    identity: def.identity,
    version: reducerVersion(def.identity, def.parts),
    initial: def.initial,
    advance(acc, events) {
      const next = cloneAcc(acc)
      def.fold(next, def.rawEvents ? events : filterKnownEvents(events))
      return next
    },
    finish: def.finish,
    reduce(events) {
      const acc = def.initial()
      def.fold(acc, def.rawEvents ? events : filterKnownEvents(events))
      return def.finish(acc)
    },
  }
}
