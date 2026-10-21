import { isAbsolute, join, resolve } from 'node:path'

/** Frozen launcher ABI. Changes require a new version and compatibility fixture. */
export const DISPATCH_LAUNCH_VERSION = 1
export const DISPATCH_GENERATION_ENV = 'AB_DISPATCH_GENERATION'
export const GENERATION_ENTRY = 'bin/ab-dispatch-generation.ts'
export const GENERATION_EXITS = { stopped: 80, handoff: 81, failed: 82 } as const
export const GENERATION_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGTERM'] as const
export interface GenerationLaunch {
  version: 1
  runtimeRoot: string
  checkout: string
  originalInstall?: string
  run?: string
  lineage?: string
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
    value.version !== 1 ||
    !value.run ||
    !value.lineage ||
    !value.originalInstall ||
    !isAbsolute(value.originalInstall)
  )
    throw new Error('invalid generation context')
  return value
}
