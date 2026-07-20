/**
 * Durable operator controls for one build.
 *
 * The dashboard and the sessionless CLI both call this module: it owns the
 * event-reduced active-build checks, human attribution, and event ordering so
 * the two surfaces cannot drift. Controls only append requests/answers; the
 * normal runner and dispatcher consume them.
 */
import type { AbEvent } from '../events/catalog'
import { humanActor } from '../events/envelope'
import { reduceBuild, type BuildState } from '../kernel/reducer'
import type { BuildStatus } from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import type { BuildStore } from '../store/types'
import {
  withSessionlessStore,
  type StoreOpener,
} from './store-opening'

const ACTIVE_STATUSES: readonly BuildStatus[] = ['running', 'paused', 'blocked']

/** Retry carries no phase guidance, but the event schema still requires a
 * nonempty audit answer. The reducer/materializer route on `resolution`, so
 * this text is never presented to the next phase as guidance. */
export const BARE_RETRY_ANSWER =
  'Operator requested a bare retry with no feedback'

export type BuildControlAction =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'abort' }
  | { kind: 'auto-merge-on' }
  | { kind: 'auto-merge-off' }
  | { kind: 'toggle-pause' }
  | { kind: 'toggle-auto-merge' }
  | {
      kind: 'answer'
      text?: string
      /** Dashboard prompts answer only blockers captured when the field
       * opened. Omitted by the CLI, which answers every currently open one. */
      escalationIds?: readonly string[]
    }

export type BuildControlCommand =
  | 'pause'
  | 'resume'
  | 'abort'
  | 'auto-merge-on'
  | 'auto-merge-off'

export type BuildControlResult =
  | {
      kind: 'command'
      slug: string
      command: BuildControlCommand
      event: AbEvent
    }
  | {
      kind: 'answer-required'
      slug: string
      escalationIds: string[]
    }
  | {
      kind: 'answered'
      slug: string
      count: number
      resolution: 'guidance' | 'retry'
      resumed: boolean
    }

export type BuildControlErrorCode =
  | 'not-found'
  | 'wrong-repository'
  | 'inactive'
  | 'no-open-escalations'
  | 'own-session'

/** Typed codes let the dashboard turn stale selections/prompts into warnings
 * while the CLI can surface the same underlying conflict as a command error. */
export class BuildControlError extends Error {
  readonly code: BuildControlErrorCode

  constructor(code: BuildControlErrorCode, message: string) {
    super(message)
    this.name = 'BuildControlError'
    this.code = code
  }
}

/** Preserve the dashboard's attribution rule for both operator surfaces. */
export function buildControlUser(
  env: Record<string, string | undefined>,
): string {
  for (const name of ['USER', 'USERNAME']) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return 'dashboard'
}

function activeState(slug: string, state: BuildState): void {
  if (ACTIVE_STATUSES.includes(state.status)) return
  throw new BuildControlError(
    'inactive',
    `build "${slug}" is not active (status: ${state.status}); ` +
      'build controls require running, paused, or blocked',
  )
}

async function appendCommand(
  store: BuildStore,
  slug: string,
  user: string,
  command: BuildControlCommand,
): Promise<BuildControlResult> {
  const actor = humanActor(user)
  let event: AbEvent
  switch (command) {
    case 'pause':
      event = await store.append(slug, {
        actor,
        type: 'build.pause-requested',
        payload: {},
      })
      break
    case 'resume':
      event = await store.append(slug, {
        actor,
        type: 'build.resume-requested',
        payload: {},
      })
      break
    case 'abort':
      event = await store.append(slug, {
        actor,
        type: 'build.abort-requested',
        payload: {},
      })
      break
    case 'auto-merge-on':
      event = await store.append(slug, {
        actor,
        type: 'build.auto-merge-requested',
        payload: {},
      })
      break
    case 'auto-merge-off':
      event = await store.append(slug, {
        actor,
        type: 'build.auto-merge-cancelled',
        payload: {},
      })
      break
  }
  return { kind: 'command', slug, command, event }
}

export interface ControlBuildOpts {
  store: BuildStore
  /** Canonical main-repository identity stored on BuildRecord.repo. */
  repo: string
  slug: string
  env: Record<string, string | undefined>
  action: BuildControlAction
}

/** Apply one control against a freshly reduced build log. */
export async function controlBuild(
  opts: ControlBuildOpts,
): Promise<BuildControlResult> {
  const record = await opts.store.getBuild(opts.slug)
  if (record === null) {
    throw new BuildControlError(
      'not-found',
      `no build "${opts.slug}" in this store; run 'ab builds --all' to list builds`,
    )
  }
  if (record.repo !== opts.repo) {
    throw new BuildControlError(
      'wrong-repository',
      `build "${opts.slug}" belongs to repository "${record.repo}", ` +
        `not "${opts.repo}"`,
    )
  }

  const state = reduceBuild(await opts.store.getEvents(opts.slug))
  activeState(opts.slug, state)
  const user = buildControlUser(opts.env)

  switch (opts.action.kind) {
    case 'pause':
    case 'resume':
    case 'abort':
    case 'auto-merge-on':
    case 'auto-merge-off':
      return appendCommand(
        opts.store,
        opts.slug,
        user,
        opts.action.kind,
      )

    case 'toggle-pause': {
      // A blocker takes precedence over pause state in the operator flow. The
      // prompt itself is process-local and writes nothing until submitted.
      if (state.openEscalations.length > 0) {
        return {
          kind: 'answer-required',
          slug: opts.slug,
          escalationIds: state.openEscalations.map((item) => item.id),
        }
      }
      return appendCommand(
        opts.store,
        opts.slug,
        user,
        state.status === 'paused' ? 'resume' : 'pause',
      )
    }

    case 'toggle-auto-merge':
      return appendCommand(
        opts.store,
        opts.slug,
        user,
        state.autoMerge.requested ? 'auto-merge-off' : 'auto-merge-on',
      )

    case 'answer': {
      const captured =
        opts.action.escalationIds === undefined
          ? undefined
          : new Set(opts.action.escalationIds)
      const open =
        captured === undefined
          ? state.openEscalations
          : state.openEscalations.filter((item) => captured.has(item.id))
      if (open.length === 0) {
        throw new BuildControlError(
          'no-open-escalations',
          captured === undefined
            ? `build "${opts.slug}" has no open escalations to answer`
            : `build "${opts.slug}" is no longer blocked by the captured escalation(s)`,
        )
      }

      const guidance = (opts.action.text ?? '').trim()
      const resolution = guidance === '' ? 'retry' : 'guidance'
      const answer = guidance === '' ? BARE_RETRY_ANSWER : guidance
      // One stable actor value for this entire multi-event operator action.
      const actor = humanActor(user)
      const alsoPaused = state.status === 'paused'

      // Appends are intentionally one-at-a-time. If an append fails midway, a
      // retry re-reduces the log and filters already answered ids out.
      for (const escalation of open) {
        await opts.store.append(opts.slug, {
          actor,
          type: 'escalation.answered',
          payload: { id: escalation.id, answer, resolution },
        })
      }
      // Clear every blocker before making paused work actionable.
      if (alsoPaused) {
        await opts.store.append(opts.slug, {
          actor,
          type: 'build.resume-requested',
          payload: {},
        })
      }
      return {
        kind: 'answered',
        slug: opts.slug,
        count: open.length,
        resolution,
        resumed: alsoPaused,
      }
    }
  }
}

function actionLabel(action: BuildControlAction): string {
  switch (action.kind) {
    case 'auto-merge-on':
      return 'enable auto-merge for'
    case 'auto-merge-off':
      return 'disable auto-merge for'
    case 'toggle-auto-merge':
      return 'toggle auto-merge for'
    case 'toggle-pause':
      return 'pause or resume'
    case 'answer':
      return 'answer'
    default:
      return action.kind
  }
}

/** A phase agent may operate on another build, but never control its own. */
export function refuseOwnSessionControl(
  slug: string,
  action: BuildControlAction,
  env: Record<string, string | undefined>,
): void {
  const session = env['AB_SESSION']?.trim()
  const build = env['AB_BUILD']?.trim()
  if (session === undefined || session === '' || build !== slug) return
  throw new BuildControlError(
    'own-session',
    `cannot ${actionLabel(action)} build "${slug}" from its own phase session ` +
      '(AB_SESSION/AB_BUILD conflict); run this command outside that build session',
  )
}

export interface AbBuildControlOpts {
  targetRepo: string
  env: Record<string, string | undefined>
  exec: Exec
  slug: string
  action: BuildControlAction
  /** Explicit `--store`; selection remains --store > AB_STORE > repo-local. */
  storeRef?: string
  /** Injectable adapter seam for unit tests. */
  openStore?: StoreOpener
}

/** Sessionless command shell: resolve repository/store, control, always close. */
export async function abBuildControl(
  opts: AbBuildControlOpts,
): Promise<BuildControlResult> {
  // Do this before opening a store: the conflict is ambient and no read is
  // needed to know that an own-phase control attempt is forbidden.
  refuseOwnSessionControl(opts.slug, opts.action, opts.env)

  return withSessionlessStore(opts, ({ store, repo }) =>
    controlBuild({
      store,
      repo,
      slug: opts.slug,
      env: opts.env,
      action: opts.action,
    }),
  )
}
