/**
 * Derived reducers (RFC 0007 §8, SPEC §7.7): a repository rollup over every
 * build's saved value of one registered build reducer.
 *
 * A rollup is three parts: the build reducer (`buildReducer`, a registered
 * build-scope named value), a pure contribution function from that build's
 * finished value to its share of the rollup, and a repository accumulator
 * with `add` and `subtract`. Contributions must be invertible, so a build that
 * changes again (a new closed segment, a reopen) has its previously absorbed
 * contribution subtracted before its new one is added.
 *
 * The store's engine (`store/rollups.ts`) advances a rollup by the builds that
 * changed since its saved change position. Definitions here are pure and
 * browser-safe; they never read the store.
 */
import type { z } from 'zod'

export interface RollupDefinition<
  Args = unknown,
  Read = unknown,
  Acc = unknown,
  C = unknown,
  Value = unknown,
> {
  /** The ledger name; revisions go through `bun tools/reducer-revision.ts`. */
  readonly identity: string
  /** Derived from the identity and the build reducer's version, never edited. */
  readonly version: number
  /** The registered build-scope reducer whose finished value is contributed. */
  readonly buildReducer: string
  /** Key arguments, parsed with defaults before hashing: each combination is
   * its own rollup with its own accumulator. */
  readonly args: z.ZodType<Args>
  /** Read-time arguments, parsed with defaults: they shape `finish` only and
   * never create a key. */
  readonly read: z.ZodType<Read>
  readonly accSchema: z.ZodType<Acc>
  readonly contributionSchema: z.ZodType<C>
  /** The finished value a reader can represent; a remote client rejects any
   * answer outside it. */
  readonly valueSchema: z.ZodType
  initial(): Acc
  /** One build's share, or `null` for none. Pure. */
  contribute(buildValue: unknown, args: Args, now: Date): C | null
  /** Fold a contribution into `acc` in place. */
  add(acc: Acc, contribution: C): void
  /** Remove a previously added contribution from `acc` in place. */
  subtract(acc: Acc, contribution: C): void
  /** Whether `acc` holds anything retention drops at `now`. Constant work in
   * builds and events. */
  expired(acc: Acc, now: Date): boolean
  /** Drop what retention no longer keeps; returns whether anything changed. */
  prune(acc: Acc, now: Date): boolean
  /** The answer. Applies retention on its own, so an unpruned accumulator
   * never reports an expired entry. */
  finish(acc: Acc, read: Read, now: Date, position: string): Value
}

// biome-ignore lint/suspicious/noExplicitAny: the rollup table is heterogeneous
export type AnyRollupDefinition = RollupDefinition<any, any, any, any, any>
