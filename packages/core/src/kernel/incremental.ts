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
  /** Bump when `Acc`'s shape or the fold's semantics change: a cached
   * accumulator is only valid for the version that wrote it. */
  readonly version: number
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
  version: number
  initial: () => Acc
  fold: (acc: Acc, events: readonly Event[]) => void
  finish: (acc: Acc) => State
}): IncrementalReducer<Acc, Event, State> {
  return {
    version: def.version,
    initial: def.initial,
    advance(acc, events) {
      const next = cloneAcc(acc)
      def.fold(next, events)
      return next
    },
    finish: def.finish,
    reduce(events) {
      const acc = def.initial()
      def.fold(acc, events)
      return def.finish(acc)
    },
  }
}
