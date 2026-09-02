import type { Config } from '../config/schema'
import { configSchema } from '../config/schema'
import type { AbEvent } from '../events/catalog'
import type { Artifact, ArtifactInput } from '../store/types'

export const BUILD_EFFECTIVE_CONFIG_ARTIFACT = 'build-runner-effective-config'
export const BUILD_RUNNER_DIAGNOSTIC_ARTIFACT = 'build-runner-diagnostic'

export type BuildRunnerDiagnosticOutcome = 'lease-held' | 'setup-failed' | 'failed'

export interface BuildRunnerDiagnostic {
  instance: string
  outcome: BuildRunnerDiagnosticOutcome
  error: string
}

/** JSON form of the normalized config's strict declarative input shape. */
export function effectiveBuildConfigContent(config: Config): string {
  const { verify, finalize, ...root } = config
  return JSON.stringify({
    ...root,
    verify: { steps: verify.steps, ...verify.stepConfigs },
    finalize: { steps: finalize.steps, ...finalize.stepConfigs },
  })
}

export function parseEffectiveBuildConfig(artifact: Artifact): Config {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(artifact.content))
  } catch (error) {
    throw new Error(
      `invalid ${BUILD_EFFECTIVE_CONFIG_ARTIFACT} JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const result = configSchema.safeParse(value)
  if (!result.success) {
    throw new Error(
      `invalid ${BUILD_EFFECTIVE_CONFIG_ARTIFACT}: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  return result.data
}

/** Latest workspace location not followed by release. Historical events use
 * the provider ref as the path compatibility fallback. */
export function selectOpenWorkspace(events: readonly AbEvent[]): {
  path: string
  branch: string
} | null {
  let open: { path: string; branch: string } | null = null
  for (const event of events) {
    if (event.type === 'workspace.provisioned') {
      open = { path: event.payload.path ?? event.payload.ref, branch: event.payload.branch }
    } else if (event.type === 'workspace.released') {
      open = null
    }
  }
  return open
}

export function diagnosticArtifact(diagnostic: BuildRunnerDiagnostic): ArtifactInput {
  return {
    kind: BUILD_RUNNER_DIAGNOSTIC_ARTIFACT,
    content: JSON.stringify(diagnostic),
    metadata: { instance: diagnostic.instance, outcome: diagnostic.outcome },
  }
}

export function parseDiagnostic(artifact: Artifact): BuildRunnerDiagnostic | null {
  try {
    const value = JSON.parse(
      new TextDecoder().decode(artifact.content),
    ) as Partial<BuildRunnerDiagnostic>
    if (
      typeof value.instance !== 'string' ||
      typeof value.error !== 'string' ||
      !['lease-held', 'setup-failed', 'failed'].includes(value.outcome ?? '')
    ) {
      return null
    }
    return value as BuildRunnerDiagnostic
  } catch {
    return null
  }
}
