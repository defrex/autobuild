/**
 * `buildRoster`, a rollup (SPEC §7.7): every live build plus the newest
 * finished builds, with their outcome and completion time.
 *
 * - `buildRosterEntry` is the build-scope reducer it reads: the build's kind,
 *   its creation time and its latest terminal fact. `build.completed` and
 *   `build.aborted` overwrite one terminal field in log order, the build
 *   reducer's "terminal, latest wins" rule (SPEC §15.5).
 * - The accumulator keeps every live entry and the newest
 *   `BUILD_ROSTER_HISTORY` finished entries. A completion beyond the cap
 *   prunes the oldest; a build that leaves the history is not replaced by an
 *   older completion, so the answer may show fewer finished builds than
 *   `BUILD_ROSTER_FINISHED` after many reopens.
 * - No key or read-time arguments: one key per repository.
 *
 * Pure and browser-safe.
 */
import { z } from 'zod'
import type { AbEvent } from '../events/catalog'
import type { BuildOutcome } from '../ontology'
import { defineReducer } from './incremental'
import { reducerVersion } from './reducer-identity'
import type { RollupDefinition } from './rollup'

/** Finished entries the accumulator retains. */
export const BUILD_ROSTER_HISTORY = 50
/** Finished entries the answer reports. */
export const BUILD_ROSTER_FINISHED = 10

export type RosterOutcome = 'merged' | 'closed' | 'aborted'
export type RosterKind = 'work' | 'node'

/** A terminal fact's roster outcome: `merged` stays, every other completion
 * outcome is `closed`, an abort is `aborted`. */
export function rosterOutcome(terminal: BuildOutcome | 'aborted'): RosterOutcome {
  return terminal === 'merged' || terminal === 'aborted' ? terminal : 'closed'
}

/** One build's roster entry: `finished` is present exactly when the build
 * reducer's status is `done` or `aborted`. */
export interface BuildRosterEntry {
  kind: RosterKind
  /** Timestamp of the build's first event. */
  createdAt?: string
  finished?: { outcome: RosterOutcome; completedAt: string }
}

interface RosterEntryAcc {
  kind: RosterKind
  createdAt?: string
  terminal?: { outcome: RosterOutcome; at: string }
}

export const buildRosterEntryReducer = defineReducer<RosterEntryAcc, AbEvent, BuildRosterEntry>({
  identity: 'buildRosterEntry',
  initial: () => ({ kind: 'work' }),
  fold(acc, events) {
    for (const event of events) {
      acc.createdAt ??= event.ts
      switch (event.type) {
        case 'build.created':
          acc.kind = event.payload.kind ?? 'work'
          break
        // Terminal, latest wins: an in-order overwrite, cleared by nothing.
        case 'build.completed':
          acc.terminal = { outcome: rosterOutcome(event.payload.outcome), at: event.ts }
          break
        case 'build.aborted':
          acc.terminal = { outcome: 'aborted', at: event.ts }
          break
      }
    }
  },
  finish: (acc) => ({
    kind: acc.kind,
    ...(acc.createdAt !== undefined ? { createdAt: acc.createdAt } : {}),
    ...(acc.terminal !== undefined
      ? { finished: { outcome: acc.terminal.outcome, completedAt: acc.terminal.at } }
      : {}),
  }),
})

const position = z.string().regex(/^(0|[1-9][0-9]*)$/)
const kindSchema = z.enum(['work', 'node'])
const liveEntrySchema = z
  .object({ slug: z.string().min(1), kind: kindSchema, createdAt: z.string().optional() })
  .strict()
const finishedEntrySchema = z
  .object({
    slug: z.string().min(1),
    kind: kindSchema,
    outcome: z.enum(['merged', 'closed', 'aborted']),
    completedAt: z.string(),
  })
  .strict()
export type BuildRosterLive = z.infer<typeof liveEntrySchema>
export type BuildRosterFinished = z.infer<typeof finishedEntrySchema>

const contributionSchema = z.discriminatedUnion('state', [
  liveEntrySchema.extend({ state: z.literal('live') }),
  finishedEntrySchema.extend({ state: z.literal('finished') }),
])
export type BuildRosterContribution = z.infer<typeof contributionSchema>

const accSchema = z
  .object({
    live: z.record(z.string().min(1), liveEntrySchema),
    /** Newest first; `expired` and `prune` enforce the cap. */
    finished: z.array(finishedEntrySchema),
  })
  .strict()
export type BuildRosterAcc = z.infer<typeof accSchema>

const valueSchema = z
  .object({
    position,
    live: z.array(liveEntrySchema),
    finished: z.array(finishedEntrySchema).max(BUILD_ROSTER_FINISHED),
  })
  .strict()
export interface BuildRosterValue {
  /** The repository change position the answer reflects. */
  position: string
  /** Every live build, oldest first (no creation time first), then by slug. */
  live: BuildRosterLive[]
  /** Up to `BUILD_ROSTER_FINISHED` retained finished builds, newest first. */
  finished: BuildRosterFinished[]
}

const noArgs = z.object({}).strict()
type NoArgs = z.infer<typeof noArgs>

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
/** Newest completion first, then slug. */
const newestFirst = (a: BuildRosterFinished, b: BuildRosterFinished) =>
  order(b.completedAt, a.completedAt) || order(a.slug, b.slug)

function contribute(
  value: unknown,
  _args: NoArgs,
  _now: Date,
  slug: string,
): BuildRosterContribution {
  const entry = value as BuildRosterEntry
  if (entry.finished !== undefined)
    return {
      state: 'finished',
      slug,
      kind: entry.kind,
      outcome: entry.finished.outcome,
      completedAt: entry.finished.completedAt,
    }
  return {
    state: 'live',
    slug,
    kind: entry.kind,
    ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
  }
}

function remove(acc: BuildRosterAcc, slug: string): void {
  const at = acc.finished.findIndex((entry) => entry.slug === slug)
  if (at >= 0) acc.finished.splice(at, 1)
}

function add(acc: BuildRosterAcc, contribution: BuildRosterContribution): void {
  const { state, ...entry } = contribution
  if (state === 'live') {
    acc.live[entry.slug] = entry as BuildRosterLive
    return
  }
  const finished = entry as BuildRosterFinished
  remove(acc, finished.slug)
  let at = acc.finished.findIndex((other) => newestFirst(finished, other) < 0)
  if (at < 0) at = acc.finished.length
  acc.finished.splice(at, 0, finished)
  acc.finished.length = Math.min(acc.finished.length, BUILD_ROSTER_HISTORY)
}

/** Remove a build's entry. A finished entry already pruned is a no-op, and
 * nothing older takes its place. */
function subtract(acc: BuildRosterAcc, contribution: BuildRosterContribution): void {
  if (contribution.state === 'live') delete acc.live[contribution.slug]
  else remove(acc, contribution.slug)
}

const expired = (acc: BuildRosterAcc) => acc.finished.length > BUILD_ROSTER_HISTORY

function prune(acc: BuildRosterAcc): boolean {
  if (!expired(acc)) return false
  acc.finished.length = BUILD_ROSTER_HISTORY
  return true
}

function finish(acc: BuildRosterAcc, _read: NoArgs, _now: Date, at: string): BuildRosterValue {
  const live = Object.values(acc.live)
    .map((entry) => ({ ...entry }))
    .sort(
      (a, b) =>
        (a.createdAt === undefined ? 0 : 1) - (b.createdAt === undefined ? 0 : 1) ||
        order(a.createdAt ?? '', b.createdAt ?? '') ||
        order(a.slug, b.slug),
    )
  const finished = acc.finished.slice(0, BUILD_ROSTER_FINISHED).map((entry) => ({ ...entry }))
  return { position: at, live, finished }
}

export const buildRosterRollup: RollupDefinition<
  NoArgs,
  NoArgs,
  BuildRosterAcc,
  BuildRosterContribution,
  BuildRosterValue
> = {
  identity: 'buildRoster',
  version: reducerVersion('buildRoster', [buildRosterEntryReducer]),
  buildReducer: 'buildRosterEntry',
  args: noArgs,
  read: noArgs,
  accSchema,
  contributionSchema,
  valueSchema,
  initial: () => ({ live: {}, finished: [] }),
  contribute,
  add,
  subtract,
  expired,
  prune,
  finish,
}
