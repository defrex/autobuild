import type { SourceLaunch } from './dispatch-upgrade-source'
import { isAbsolute, join, resolve } from 'node:path'

/** Frozen launcher ABI. Changes require a new version and compatibility fixture. */
export const DISPATCH_OVERLAP_VERSION = 1
export const DISPATCH_LAUNCH_VERSION = 1
export const DISPATCH_GENERATION_ENV = 'AB_DISPATCH_GENERATION'
export const GENERATION_ENTRY = 'bin/ab-dispatch-generation.ts'
export const GENERATION_EXITS = { stopped: 80, handoff: 81, failed: 82 } as const
export const GENERATION_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGTERM'] as const
/** Negotiated independently of the frozen v1 launch/overlap protocols. */
export const DISPATCH_ROLLBACK_VERSION = 1
export interface RollbackContext {
  version: 1
  correlation: string
  lineage: string
  predecessor: string
  successor: string
  handoff: string
  takeoverAt: string
  failures: 3
  failed: { root: string; cacheId: string }
  restored: { root: string; cacheId: string }
}
export interface GenerationLaunch {
  version: 1
  rollbackVersion?: 1
  rollback?: RollbackContext
  recovery?: { predecessor: string; successor: string; handoff: string }
  overlapVersion?: 1
  journal?: { storeRef: string; repo: string }
  runtimeRoot: string
  checkout: string
  sourceLaunch?: SourceLaunch
  originalInstall?: string
  run?: string
  lineage?: string
  predecessorRoot?: string
  predecessorCorrelation?: string
  predecessor?: string
  launcherPid?: number
}
export function generationArguments(root: string, argv: readonly string[]): string[] {
  return [
    '--no-install',
    '--tsconfig-override',
    join(root, 'tsconfig.json'),
    join(root, GENERATION_ENTRY),
    ...argv,
  ]
}
export function consumeGenerationMarker(
  env: Record<string, string | undefined>,
  ownRoot: string,
): GenerationLaunch {
  const raw = env[DISPATCH_GENERATION_ENV]
  delete env[DISPATCH_GENERATION_ENV]
  const marker = JSON.parse(raw ?? 'null') as GenerationLaunch | null
  if (
    !marker ||
    !validSourceLaunch(marker.sourceLaunch) ||
    !validRecoveryContext(marker) ||
    marker.version !== DISPATCH_LAUNCH_VERSION ||
    typeof marker.runtimeRoot !== 'string' ||
    !isAbsolute(marker.runtimeRoot) ||
    resolve(marker.runtimeRoot) !== resolve(ownRoot) ||
    typeof marker.checkout !== 'string' ||
    !isAbsolute(marker.checkout)
  ) {
    throw new Error('invalid dispatcher generation launch contract')
  }
  return marker
}
export function generationResult(
  code: number,
  signal: string | number | null,
): { reason: 'stopped' | 'handoff' | 'failed'; publicCode: number } {
  if (signal !== null) return { reason: 'failed', publicCode: 1 }
  if (code === GENERATION_EXITS.stopped) return { reason: 'stopped', publicCode: 0 }
  // Handoff is reserved; this launcher deliberately implements no target selection.
  if (code === GENERATION_EXITS.handoff) return { reason: 'handoff', publicCode: 1 }
  return { reason: 'failed', publicCode: code === GENERATION_EXITS.failed || code === 0 ? 1 : code }
}

export const DISPATCH_LAUNCH_CONTEXT_ENV = 'AB_DISPATCH_LAUNCH_CONTEXT'
export function launchContext(
  env: Record<string, string | undefined>,
): GenerationLaunch | undefined {
  const raw = env[DISPATCH_LAUNCH_CONTEXT_ENV]
  if (!raw) return undefined
  const value = JSON.parse(raw) as GenerationLaunch
  if (
    !validSourceLaunch(value.sourceLaunch) ||
    !validRecoveryContext(value) ||
    value.version !== 1 ||
    !value.run ||
    !value.lineage ||
    !value.originalInstall ||
    !isAbsolute(value.originalInstall)
  )
    throw new Error('invalid generation context')
  return value
}

function validSourceLaunch(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as SourceLaunch
  return (
    Object.keys(v).sort().join(',') === 'baseline,commit,repository' &&
    typeof v.repository === 'string' &&
    isAbsolute(v.repository) &&
    typeof v.commit === 'string' &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.commit) &&
    typeof v.baseline === 'string' &&
    /^[a-f0-9]{64}$/.test(v.baseline)
  )
}

export function validRecoveryContext(launch: GenerationLaunch): boolean {
  if (launch.rollbackVersion !== undefined && launch.rollbackVersion !== 1) return false
  if (launch.rollback !== undefined && (!launch.rollback || typeof launch.rollback !== 'object'))
    return false
  if (
    launch.recovery !== undefined &&
    (!launch.recovery || typeof launch.recovery !== 'object' || launch.predecessor)
  )
    return false
  const context = launch.rollback
  if (!context && !launch.recovery) return true
  if (
    launch.rollbackVersion !== DISPATCH_ROLLBACK_VERSION ||
    typeof launch.lineage !== 'string' ||
    !launch.lineage ||
    typeof launch.run !== 'string' ||
    !launch.run ||
    !isAbsolute(launch.checkout) ||
    !isAbsolute(launch.runtimeRoot)
  )
    return false
  if (
    launch.recovery &&
    ![launch.recovery.predecessor, launch.recovery.successor, launch.recovery.handoff].every(
      (v) => typeof v === 'string' && v.length > 0,
    )
  )
    return false
  if (!context) return true
  const validRuntime = (runtime: RollbackContext['failed']) =>
    runtime &&
    typeof runtime.cacheId === 'string' &&
    /^[^/]+-[a-f0-9]{64}$/.test(runtime.cacheId) &&
    runtime.root === join(launch.checkout, '.autobuild/runtime', runtime.cacheId, 'distribution')
  return (
    context.version === 1 &&
    context.lineage === launch.lineage &&
    [context.correlation, context.predecessor, context.successor, context.handoff].every(
      (v) => typeof v === 'string' && v.length > 0,
    ) &&
    typeof context.takeoverAt === 'string' &&
    Number.isFinite(Date.parse(context.takeoverAt)) &&
    context.failures === 3 &&
    validRuntime(context.failed) &&
    validRuntime(context.restored) &&
    context.failed.root !== context.restored.root &&
    context.restored.root === launch.runtimeRoot &&
    !launch.predecessor &&
    !launch.recovery
  )
}

/** Optional runtime-reader extension; independent of launch/overlap v1. */
export const DISPATCH_CONDITIONAL_VERSION = 1
export const DISPATCH_CONDITIONAL_ENV = 'AB_DISPATCH_CONDITIONAL_UPGRADE'
export interface UpgradeGuards {
  handoff: import('../kernel/dispatch-upgrade').Handoff | null
  rollbackRecorded: boolean
  failedRoot: string | null
}
export interface UpgradeProjection {
  version: 1
  handoff: import('../kernel/dispatch-upgrade').Handoff | null
  takeover: boolean
  journal?: GenerationLaunch['journal']
  rollbackVersion?: 1
  rollbackRetained?: boolean
  takeoverAt?: string
  takeoverPayload?: unknown
  completed?: boolean
  accepted?: boolean
  successor?: string
  released?: boolean
}
export interface UpgradeCondition {
  version: 1
  identity: string
  position?: string
  guards?: UpgradeGuards
}
export type ConditionalUpgradeResult =
  | {
      conditionalVersion: 1
      kind: 'full'
      identity: string
      position?: string
      guards?: UpgradeGuards
      projection: UpgradeProjection
    }
  | {
      conditionalVersion: 1
      kind: 'unchanged'
      identity: string
      position: string
      handoff: UpgradeProjection['handoff']
      rollbackRetained: boolean
    }

export function validChangePosition(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
}
// The public launcher outlives its runtimes. Only these fields belong to its
// contract; target/source descriptors and future runtime fields remain opaque.
const launcherHandoffFields = ['root', 'cacheId', 'run', 'lineage', 'correlation'] as const
function validHandoff(value: unknown): boolean {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const h = value as Record<string, unknown>
  return (
    launcherHandoffFields.every((key) => typeof h[key] === 'string') && isAbsolute(h.root as string)
  )
}
function sameLauncherHandoff(
  left: UpgradeProjection['handoff'],
  right: UpgradeGuards['handoff'],
): boolean {
  return (
    left === null ||
    (right !== null && launcherHandoffFields.every((key) => left[key] === right[key]))
  )
}
function validUpgradeProjection(value: unknown): value is UpgradeProjection {
  if (!value || typeof value !== 'object') return false
  const p = value as UpgradeProjection
  return (
    p.version === 1 &&
    validHandoff(p.handoff) &&
    typeof p.takeover === 'boolean' &&
    ['rollbackRetained', 'completed', 'accepted', 'released'].every((key) => {
      const flag = (p as unknown as Record<string, unknown>)[key]
      return flag === undefined || typeof flag === 'boolean'
    }) &&
    (p.rollbackVersion === undefined || p.rollbackVersion === 1) &&
    (p.takeoverAt === undefined || typeof p.takeoverAt === 'string') &&
    (p.successor === undefined || typeof p.successor === 'string') &&
    (p.journal === undefined ||
      (!!p.journal && typeof p.journal.storeRef === 'string' && typeof p.journal.repo === 'string'))
  )
}
export function validUpgradeGuards(value: unknown): value is UpgradeGuards {
  if (!value || typeof value !== 'object') return false
  const v = value as UpgradeGuards
  return (
    validHandoff(v.handoff) &&
    typeof v.rollbackRecorded === 'boolean' &&
    (v.failedRoot === null || (typeof v.failedRoot === 'string' && isAbsolute(v.failedRoot))) &&
    (v.rollbackRecorded || v.failedRoot === null)
  )
}
export function consumeUpgradeCondition(
  env: Record<string, string | undefined>,
): UpgradeCondition | undefined {
  const raw = env[DISPATCH_CONDITIONAL_ENV]
  delete env[DISPATCH_CONDITIONAL_ENV]
  if (raw === undefined) return undefined
  const v = JSON.parse(raw) as UpgradeCondition
  if (
    v?.version !== 1 ||
    typeof v.identity !== 'string' ||
    !v.identity ||
    (v.position === undefined
      ? v.guards !== undefined
      : !validChangePosition(v.position) || !validUpgradeGuards(v.guards))
  )
    throw new Error('invalid conditional upgrade request')
  return v
}

/** One cache per reader/query. A helper still runs on every call, so a broken
 * successor can never be hidden by its last successful projection. */
export function conditionalUpgradeClient() {
  let cache:
    | { identity: string; position: string; guards: UpgradeGuards; projection: UpgradeProjection }
    | undefined
  return async (
    identity: string,
    read: (request: UpgradeCondition) => Promise<unknown>,
  ): Promise<UpgradeProjection> => {
    if (cache?.identity !== identity) cache = undefined
    try {
      const request: UpgradeCondition = {
        version: 1,
        identity,
        ...(cache ? { position: cache.position, guards: cache.guards } : {}),
      }
      const raw = await read(request)
      if (!raw || typeof raw !== 'object') throw new Error('invalid upgrade reader response')
      const result = raw as ConditionalUpgradeResult
      if (!('conditionalVersion' in raw)) {
        cache = undefined
        const legacy = raw as UpgradeProjection
        if (!validUpgradeProjection(legacy))
          throw new Error('invalid legacy upgrade reader response')
        return legacy
      }
      if (result.conditionalVersion !== 1 || result.identity !== identity)
        throw new Error('incompatible conditional upgrade reader')
      if (result.kind === 'unchanged') {
        if (
          !cache ||
          result.position !== cache.position ||
          !validHandoff(result.handoff) ||
          typeof result.rollbackRetained !== 'boolean' ||
          !sameLauncherHandoff(result.handoff, cache.guards.handoff) ||
          (result.rollbackRetained && !cache.guards.rollbackRecorded)
        )
          throw new Error('invalid unchanged upgrade response')
        cache.projection = {
          ...cache.projection,
          handoff: result.handoff,
          rollbackRetained: result.rollbackRetained,
        }
        return cache.projection
      }
      if (
        result.kind !== 'full' ||
        !validUpgradeProjection(result.projection) ||
        (result.position === undefined
          ? result.guards !== undefined
          : !validChangePosition(result.position) || !validUpgradeGuards(result.guards))
      )
        throw new Error('invalid full upgrade response')
      cache =
        result.position !== undefined && result.guards
          ? {
              identity,
              position: result.position,
              guards: result.guards,
              projection: result.projection,
            }
          : undefined
      return result.projection
    } catch (error) {
      cache = undefined
      throw error
    }
  }
}
