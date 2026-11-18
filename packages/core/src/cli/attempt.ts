/**
 * Optimization attempt resolution for the CLI (RFC 0005 §6.1, §6.2): whether
 * a session's build is an in-flight attempt of an optimization node, and the
 * harness paths its contribution touches.
 *
 * A build is an attempt exactly when it targets a node whose objective was
 * accepted and its ticket was filed from one of that node's in-flight
 * proposals. Proposal and child refs are compared through the recorded
 * ticket-migration identity, as the dispatcher compares them, so a proposal
 * recorded before a migration still matches a child dispatched after it.
 */
import { compilePathSelectors } from '../config/path-selectors'
import { parseNulChangedPaths } from '../kernel/head-paths'
import {
  optimizationAttempt,
  type InFlightAttempt,
  type OptimizationState,
} from '../kernel/optimization'
import type { BuildState } from '../kernel/reducer'
import { migrationIdentity } from '../kernel/ticket-migrations'
import type { TicketRef } from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import { readBuildFacts, readRepositoryFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'

export interface AttemptContext {
  /** The node build's slug. */
  node: string
  attempt: InFlightAttempt
  optimization: OptimizationState
}

export interface AttemptInput {
  slug: string
  state: BuildState
  /** The build's `build.created` repository. */
  repo: string
  /** The build's `build.created` ticket. */
  ticket: TicketRef
  /** The configured ticket source, the migration destination. Loaded only
   * once the node is known to be an optimization node. */
  ticketSource: () => Promise<string>
}

/**
 * The attempt `input.slug` is, or undefined. A build without a target reads
 * nothing; any other build reads its node's served reduced value once, and
 * only an optimization node adds one served repository value. Unresolvable
 * migration continuity throws: an attempt is never silently treated as an
 * ordinary build.
 */
export async function readAttemptContext(
  store: Pick<BuildStore, 'getReducerValue' | 'getRepo'>,
  input: AttemptInput,
): Promise<AttemptContext | undefined> {
  const target = input.state.target
  if (input.state.kind === 'node' || target === undefined) return undefined
  const optimization = (await readBuildFacts(store, target.build)).value.state.optimization
  if (optimization === undefined) return undefined
  const migrations = (await readRepositoryFacts(store, input.repo)).value.ticketMigrations
  const key = migrationIdentity(migrations, await input.ticketSource())
  let attempt: InFlightAttempt | undefined
  try {
    attempt = optimizationAttempt(optimization, input.ticket, (ref) => key(ref, input.slug))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `cannot resolve optimization attempt identity for build ${input.slug}: ${detail}`,
    )
  }
  if (attempt === undefined) return undefined
  return { node: target.build, attempt, optimization }
}

/** The sorted net contribution paths between `base` and `head` that the
 * objective's harness selectors match. A reverted harness edit is absent. */
export async function harnessPathsTouched(
  exec: Exec,
  workspacePath: string,
  base: string,
  head: string,
  harness: readonly string[],
): Promise<string[]> {
  const args = ['git', 'diff', '--no-renames', '--name-only', '-z', base, head, '--']
  const result = await exec(args, { cwd: workspacePath })
  if (result.exitCode !== 0)
    throw new Error(
      `${args.join(' ')} exited ${result.exitCode}: ` +
        `${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
    )
  const matches = compilePathSelectors(harness)
  return [...new Set(parseNulChangedPaths(result.stdout))].filter(matches).sort()
}

/** The `ab done` refusal for an attempt whose contribution changes its harness. */
export function harnessRejection(paths: readonly string[]): Error {
  return new Error(
    'publication rejected: an optimization attempt must not change its harness ' +
      "(the measurement's ruler):\n" +
      paths.map((path) => `  ${path}`).join('\n') +
      "\nRevert these paths to the contribution base, commit, then retry 'ab done'.",
  )
}
