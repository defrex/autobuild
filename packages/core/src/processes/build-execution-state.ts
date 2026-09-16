import type { Config } from '../config/schema'
import { configSchema } from '../config/schema'
import { BUILD_OWNED_CONFIG_PATHS } from '../config/live'
import { isPipelineSourceRef, type PipelineSourceMeta } from '../config/pipeline-source'
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

/** Read the artifact metadata's revision + pipeline-source projection. Old
 * deposits (and externally written ones) carry no `pipelineSource`; status and
 * the dashboard render that as "unknown (pre-pin)" instead of guessing. */
export function parseBuildConfigMetadata(artifact: Artifact): {
  revision?: number
  pipelineSource?: PipelineSourceMeta
} {
  const metadata = artifact.meta.metadata
  const revision = metadata.revision
  const raw = metadata.pipelineSource
  let pipelineSource: PipelineSourceMeta | undefined
  if (typeof raw === 'object' && raw !== null) {
    const value = raw as Record<string, unknown>
    if (isPipelineSourceRef(value.ref)) {
      pipelineSource = {
        ref: value.ref,
        ...(typeof value.commit === 'string' ? { commit: value.commit } : {}),
      }
    }
  }
  return {
    ...(typeof revision === 'number' ? { revision } : {}),
    ...(pipelineSource !== undefined ? { pipelineSource } : {}),
  }
}

/** True when two configs' build-owned sections differ — the guest's defensive
 * guard against a deposit that rewrites the pinned pipeline without a recorded
 * pipeline-source commit advance. */
export function buildOwnedSectionsDiffer(a: Config, b: Config): boolean {
  return BUILD_OWNED_CONFIG_PATHS.some(
    (path) => JSON.stringify(a[path]) !== JSON.stringify(b[path]),
  )
}

/** Latest workspace location not followed by release. Historical events use
 * the provider ref as the path compatibility fallback. */
export function selectOpenWorkspace(events: readonly AbEvent[]): {
  ref: string
  path: string
  branch: string
} | null {
  let open: { ref: string; path: string; branch: string } | null = null
  for (const event of events) {
    if (event.type === 'workspace.provisioned') {
      open = {
        ref: event.payload.ref,
        path: event.payload.path ?? event.payload.ref,
        branch: event.payload.branch,
      }
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
