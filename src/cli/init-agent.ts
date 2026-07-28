import type { RuntimeRegistry, RuntimeUsabilityResult } from '../ports/runner/runtime'

export const SETUP_RUNTIME_PREFERENCE = ['claude', 'codex', 'pi'] as const

export interface RuntimeProbeReport {
  runtime: string
  usable: boolean
  reason: string
}

export interface SetupAgentInvocation {
  runtime: string
  prompt: string
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
}

export type SetupAgentLauncher = (invocation: SetupAgentInvocation) => Promise<number>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeProbeResult(result: RuntimeUsabilityResult): { usable: boolean; reason: string } {
  if (typeof result === 'boolean') {
    return {
      usable: result,
      reason: result ? 'usable' : 'runtime reported unavailable',
    }
  }
  return {
    usable: result.usable,
    reason: result.reason.trim() || (result.usable ? 'usable' : 'runtime reported unavailable'),
  }
}

/** Probe every registration in deterministic diagnostic order. */
export async function probeInitRuntimes(
  runtimes: RuntimeRegistry,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<RuntimeProbeReport[]> {
  const preferred = SETUP_RUNTIME_PREFERENCE.filter((name) => Object.hasOwn(runtimes, name))
  const remaining = Object.keys(runtimes)
    .filter((name) => !preferred.includes(name as (typeof SETUP_RUNTIME_PREFERENCE)[number]))
    .sort()
  const names = [...preferred, ...remaining]
  return Promise.all(
    names.map(async (runtime): Promise<RuntimeProbeReport> => {
      const registration = runtimes[runtime]!
      if (registration.initUsable === undefined) {
        return { runtime, usable: false, reason: 'no init usability probe is registered' }
      }
      try {
        const result = await registration.initUsable({
          cwd,
          env,
          models: registration.defaultModel === undefined ? [] : [registration.defaultModel],
        })
        return { runtime, ...normalizeProbeResult(result) }
      } catch (error) {
        return { runtime, usable: false, reason: `probe failed: ${message(error)}` }
      }
    }),
  )
}

/** Setup launch order is product-owned and never depends on repository contents. */
export function selectSetupRuntime(reports: readonly RuntimeProbeReport[]): string | undefined {
  for (const preferred of SETUP_RUNTIME_PREFERENCE) {
    if (reports.some((report) => report.runtime === preferred && report.usable)) return preferred
  }
  return undefined
}

/** Remove ambient Autobuild identities before starting a non-phase setup agent. */
export function sanitizeSetupEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('AB_'),
    ),
  )
}

export function setupAgentCommand(runtime: string, prompt: string): string[] {
  if (!SETUP_RUNTIME_PREFERENCE.some((supported) => supported === runtime)) {
    throw new Error(`runtime "${runtime}" has no interactive setup launcher`)
  }
  return [runtime, prompt]
}

/** Launch a shipped coding-agent CLI with inherited terminal streams. */
export const launchSetupAgent: SetupAgentLauncher = async (invocation) => {
  const proc = Bun.spawn(setupAgentCommand(invocation.runtime, invocation.prompt), {
    cwd: invocation.cwd,
    env: sanitizeSetupEnvironment(invocation.env),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
  })
  return proc.exited
}
