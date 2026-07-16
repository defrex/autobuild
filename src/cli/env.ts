/**
 * Ambient auth resolution (SPEC §8.1, D8): the runner launches every session
 * with `AB_STORE`, `AB_BUILD`, `AB_PHASE`, `AB_SESSION` (and `AB_TOKEN` for a
 * remote store) set, and the CLI resolves everything from the environment —
 * the skill only ever passes the build slug. Least privilege comes from the
 * runner, not from prompt instructions.
 *
 * Errors here are agent feedback (D6): each names the missing or malformed
 * variable and the format that would be accepted.
 */
import { CORE_PHASES, isPhase, type Phase } from '../ontology'

export interface CliEnv {
  /** Store URL or local path (`AB_STORE`). */
  store: string
  /** Build slug (`AB_BUILD`). */
  build: string
  /** Current phase, parsed from `AB_PHASE` (`<phase>[@<round>]`). */
  phase: Phase
  /** Round (loop phases) or attempt (verify/reconcile); defaults to 1. */
  round: number
  /** Session id (`AB_SESSION`). */
  session: string
  /** Scoped token for a remote store (`AB_TOKEN`) — optional locally. */
  token?: string
}

const PHASE_FORMAT = "'<phase>[@<round>]' (e.g. 'implement@2', 'verify:e2e@1')"

function requireVar(
  env: Record<string, string | undefined>,
  name: string,
  expected: string,
): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set — expected ${expected}. ` +
        'The runner sets ambient auth for every session (D8, SPEC §8.1).',
    )
  }
  return value
}

/** `implement@2` → `{ phase: 'implement', round: 2 }`; round defaults to 1. */
export function parseAbPhase(raw: string): { phase: Phase; round: number } {
  // Split on the LAST '@' so a malformed 'implement@2@3' reports the phase
  // part as unknown rather than silently taking the first segment.
  const at = raw.lastIndexOf('@')
  const phasePart = at === -1 ? raw : raw.slice(0, at)
  const roundPart = at === -1 ? undefined : raw.slice(at + 1)

  if (!isPhase(phasePart)) {
    throw new Error(
      `AB_PHASE "${raw}" names an unknown phase "${phasePart}" — expected one of ` +
        `${CORE_PHASES.join(', ')}, or 'verify:<step>'; format ${PHASE_FORMAT}`,
    )
  }

  let round = 1
  if (roundPart !== undefined) {
    if (!/^[1-9]\d*$/.test(roundPart)) {
      throw new Error(
        `AB_PHASE "${raw}" has a malformed round "${roundPart}" — the round must ` +
          `be a positive integer; format ${PHASE_FORMAT}`,
      )
    }
    round = Number(roundPart)
  }
  return { phase: phasePart, round }
}

/**
 * Resolve the CLI's ambient environment (D8). Throws with the exact variable
 * and expected format on the first problem found.
 */
export function resolveCliEnv(env: Record<string, string | undefined>): CliEnv {
  const store = requireVar(env, 'AB_STORE', 'the store URL or local path')
  const build = requireVar(env, 'AB_BUILD', 'the build slug')
  const rawPhase = requireVar(
    env,
    'AB_PHASE',
    `the current phase in the format ${PHASE_FORMAT}`,
  )
  const session = requireVar(env, 'AB_SESSION', 'the session id')
  const { phase, round } = parseAbPhase(rawPhase)
  const token = env['AB_TOKEN']
  return {
    store,
    build,
    phase,
    round,
    session,
    ...(token !== undefined && token !== '' ? { token } : {}),
  }
}
