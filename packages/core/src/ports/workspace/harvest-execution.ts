import type {
  BuildExecutionHandle,
  BuildExecutionIdentity,
  ExecutionObservation,
} from './build-execution'

/** Guest environment variable carrying the serialized harvest launch
 * envelope, mirroring AB_BUILD_RUNNER_OPTIONS for build children. */
export const HARVEST_RUNNER_OPTIONS_ENV = 'AB_HARVEST_RUNNER_OPTIONS'

/** Where one hosted harvest run executed: the provider-native environment
 * (and session) identity the provider supplies at launch time. */
export interface HarvestExecutionEnvironment {
  provider: string
  environmentId: string
  sessionId?: string
}

/** Immutable identity passed when a workspace provider is asked to start one
 * hosted harvest execution. Unlike builds there is no durable workspace fact,
 * so the provider resolves the disposable environment itself and reports it
 * on the returned handle's identity; `workspaceRef` is therefore optional and
 * advisory. Run state, config, and outcomes are obtained only through the
 * repository journal in the Store. */
export interface HarvestExecutionStart {
  storeRef: string
  /** Repository identity (normalized origin) the guest serves. */
  repo: string
  /** Supervisor instance id; doubles as the durable `execution` identity. */
  instance: string
  /** Remote base branch the disposable environment is provisioned from. */
  baseBranch: string
  workspaceRef?: string
  /** Repository-lease holder the guest adopts from the owning dispatch loop:
   * it skips its own claim, heartbeats this holder, and never releases. */
  leaseHolder?: string
  environment?: HarvestExecutionEnvironment
}

/** Serialized private-child envelope. A harvest guest is always owned by its
 * environment — there is no local-parent mode (the guest outlives any host
 * supervision and the environment owns teardown). */
export type HarvestRunnerLaunch = HarvestExecutionStart & {
  supervision: { kind: 'environment' }
}

/** Validate one parsed launch envelope. Invalid/missing envelopes make the
 * guest exit 2 rather than guessing at a Store or lease identity. */
export function parseHarvestRunnerLaunch(value: unknown): HarvestRunnerLaunch | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<HarvestRunnerLaunch> & {
    supervision?: Record<string, unknown>
  }
  if (
    typeof candidate.storeRef !== 'string' ||
    candidate.storeRef.length === 0 ||
    typeof candidate.repo !== 'string' ||
    candidate.repo.length === 0 ||
    typeof candidate.instance !== 'string' ||
    candidate.instance.length === 0 ||
    typeof candidate.baseBranch !== 'string' ||
    candidate.baseBranch.length === 0 ||
    candidate.supervision === undefined
  )
    return undefined
  if (candidate.supervision.kind !== 'environment') return undefined
  if (Object.hasOwn(candidate.supervision, 'parentPid')) return undefined
  if (
    candidate.leaseHolder !== undefined &&
    (typeof candidate.leaseHolder !== 'string' || candidate.leaseHolder.length === 0)
  )
    return undefined
  if (
    candidate.workspaceRef !== undefined &&
    (typeof candidate.workspaceRef !== 'string' || candidate.workspaceRef.length === 0)
  )
    return undefined
  const environment = candidate.environment
  if (environment !== undefined) {
    if (
      typeof environment !== 'object' ||
      typeof environment.provider !== 'string' ||
      environment.provider.length === 0 ||
      typeof environment.environmentId !== 'string' ||
      environment.environmentId.length === 0
    )
      return undefined
    if (
      environment.sessionId !== undefined &&
      (typeof environment.sessionId !== 'string' || environment.sessionId.length === 0)
    )
      return undefined
  }
  return candidate as HarvestRunnerLaunch
}

/** The substitutable seam at the workspace boundary for hosted harvest. A
 * remote provider implements this by provisioning one disposable environment,
 * launching the fixed harvest runner guest beside its checkout, and owning
 * full teardown. Deliberately reuses the build execution handle/identity and
 * observation types so supervision semantics (long-poll wait, teardown
 * outcome, provider liveness) are identical to builds. */
export interface HarvestExecution {
  start(input: HarvestExecutionStart): Promise<BuildExecutionHandle>
  /** Optional liveness observation of a previously recorded execution, from
   * provider state alone. Absent = this provider cannot observe; callers
   * supervise exactly as before ("cannot observe" never means "act"). */
  observe?(identity: BuildExecutionIdentity): Promise<ExecutionObservation>
}

export type { BuildExecutionHandle, ExecutionObservation }
