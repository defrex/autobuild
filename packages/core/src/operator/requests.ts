/**
 * The route-level glue the operator HTTP server applies around the shared
 * services, re-derived for the agent tool registry (operator/registry.ts).
 *
 * This module is registry-owned on purpose: the operator API routes were
 * declared out of scope for the registry ticket, so the parity between a
 * tool and its route is *proven* by the contract suite
 * (packages/hosted-store-service/src/registry.contract.test.ts) rather than
 * obtained by extraction. Every refusal text here is load-bearing — it must
 * stay byte-identical to the hosted package's `operator-server.ts` so the
 * suite's full-body comparisons hold.
 */
import { reduceBuild } from '../kernel/reducer'
import { effectiveStatus } from '../cli/dashboard/model'
import { BuildControlError, type BuildControlAction } from '../cli/build-control'
import type { BuildStore } from '../store/types'
import type { OperatorAnswerRequest } from './protocol'

/**
 * The failure body an operator API route emits when its pre-service glue
 * refuses (HttpError). Domain errors carry a `code`; these pre-service
 * refusals never do, and the registry's mapped failure must match.
 */
export interface RouteRefusal {
  kind: 'validation' | 'auth' | 'not-found' | 'conflict'
  error: string
}

/** Thrown by the registry-owned glue with the route's exact failure body. */
export class RouteRefusalError extends Error {
  override readonly name = 'RouteRefusalError'

  constructor(readonly refusal: RouteRefusal) {
    super(refusal.error)
  }
}

/** `requireRouteBuild` (the hosted package's operator-server.ts): 404 unless
 * the slug exists and
 * belongs to the named repository. */
export async function requireRouteBuild(
  store: BuildStore,
  repo: string,
  slug: string,
): Promise<void> {
  const record = await store.getBuild(slug)
  if (record === null || record.repo !== repo) {
    throw new RouteRefusalError({ kind: 'not-found', error: `unknown build "${slug}"` })
  }
}

/** The artifact revision query rule the artifact route applies to `?rev`. */
export function parseArtifactRevision(raw: string): number {
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new RouteRefusalError({
      kind: 'validation',
      error: 'rev must be a nonnegative integer',
    })
  }
  return Number(raw)
}

/**
 * The route's control-request prechecks: build existence/repo, then the
 * pending-state checks for pause and cancel-pause. Byte-identical to the
 * `POST …/control` branch in the hosted package's operator-server.ts.
 */
export async function controlPrechecks(
  store: BuildStore,
  repo: string,
  slug: string,
  action:
    | 'pause'
    | 'cancel-pause'
    | 'resume'
    | 'auto-merge-on'
    | 'auto-merge-off'
    | 'abort'
    | 'discard',
): Promise<void> {
  await requireRouteBuild(store, repo, slug)
  if (action === 'pause' || action === 'cancel-pause') {
    const state = reduceBuild(await store.getEvents(slug))
    const display = effectiveStatus(state)
    if (action === 'pause' && display === 'pausing') {
      throw new BuildControlError(
        'inactive',
        `build "${slug}" cannot pause (status: pausing); pause is already pending`,
      )
    }
    if (action === 'cancel-pause' && display !== 'pausing') {
      throw new BuildControlError(
        'inactive',
        `build "${slug}" cannot cancel pause (status: ${state.status}); cancel pause requires a pending pause`,
      )
    }
  }
}

/**
 * The route's answer request → `BuildControlAction` translation, byte-identical
 * to the `POST …/answer` branch in the hosted package's operator-server.ts.
 * The ticket-origin body
 * reader travels separately, exactly as the route passes `readTicketBody`.
 */
export function answerAction(request: OperatorAnswerRequest): {
  action: BuildControlAction
  readTicketBody?: () => Promise<string>
} {
  const action: BuildControlAction =
    request.resolution === 'guidance'
      ? { kind: 'answer', text: request.text }
      : request.resolution === 'retry'
        ? { kind: 'answer' }
        : request.resolution === 'dismiss'
          ? { kind: 'answer', text: request.text, resolve: { kind: 'dismiss-finding' } }
          : request.resolution === 'review-round-ceiling'
            ? { kind: 'answer', text: request.text, reviewRoundCeiling: request.ceiling }
            : {
                kind: 'answer',
                text: request.text,
                ...(request.ceiling !== undefined ? { reviewRoundCeiling: request.ceiling } : {}),
                resolve: {
                  kind: 'revise-spec',
                  body:
                    request.origin === 'body'
                      ? {
                          kind: 'supplied',
                          origin: 'operator API body',
                          read: async () => request.body,
                        }
                      : { kind: 'ticket' },
                },
              }
  return {
    action,
    ...(request.resolution === 'revise-spec' && request.origin === 'ticket'
      ? { readTicketBody: async () => request.body }
      : {}),
  }
}
