import type { AbEvent, EventEnvelope } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import type { IdSource } from '../ids'
import {
  currentPrAttachments,
  frozenPrImageHost,
  hostedPrAttachments,
} from '../kernel/pr-attachments'
import {
  hostedPrAttachmentAssetSchema,
  type HostedPrAttachmentAsset,
} from '../ontology'
import type { Forge } from '../ports/types'
import type { BuildStore } from '../store/types'
import type { CliEnv } from './env'

export interface PrAttachmentDeps {
  store: BuildStore
  env: CliEnv
  workspacePath: string
  forge: Forge
  ids: IdSource
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function recordHostingFailure(
  deps: PrAttachmentDeps,
  events: AbEvent[],
  designation: ReturnType<typeof currentPrAttachments>[number],
  error: unknown,
  extraRefs: string[] = [],
): Promise<void> {
  const { artifact } = designation.payload
  try {
    const observed = await deps.store.append(deps.env.build, {
      actor: KERNEL,
      type: 'observation.recorded',
      payload: {
        id: deps.ids('obs'),
        kind: 'followup',
        summary:
          `PR attachment hosting failed for ${designation.payload.filename} ` +
          `(${artifact.kind}@${artifact.rev}): ${errorMessage(error)}`,
        refs: [`${artifact.kind}@${artifact.rev}`, ...extraRefs],
      },
    })
    events.push(observed)
  } catch {
    // Hosting is a best-effort review affordance. A secondary failure to
    // record its follow-up must not hide the complete text projection or turn
    // a verification/finalize result red.
  }
}

/**
 * Host every newly designated image independently. Text projection never
 * depends on this operation; provider failures become follow-up observations.
 * A successful external upload's durable event append is intentionally not
 * swallowed, preserving deterministic adoption across the upload/write crash
 * window.
 */
export async function preparePrAttachments(
  deps: PrAttachmentDeps,
  events: AbEvent[],
  prUrl: string,
): Promise<void> {
  const target = frozenPrImageHost(events)
  if (target === undefined) return

  const designations = currentPrAttachments(events)
  const hosted = hostedPrAttachments(events, designations)
  for (const designation of designations) {
    if (!designation.payload.mediaType.startsWith('image/')) continue
    if (hosted.has(designation.seq)) continue

    let asset: HostedPrAttachmentAsset
    try {
      const capability = deps.forge.prAttachments
      if (capability === undefined) {
        throw new Error(
          `forge ${deps.forge.name} does not support PR attachment hosting`,
        )
      }
      const ref = designation.payload.artifact
      const artifact = await deps.store.getArtifact(
        deps.env.build,
        ref.kind,
        ref.rev,
      )
      if (artifact === null) {
        throw new Error(`designated artifact ${ref.kind}@${ref.rev} is missing`)
      }

      asset = hostedPrAttachmentAssetSchema.parse(
        await capability.upload({
          workspacePath: deps.workspacePath,
          target,
          prUrl,
          attachment: designation.payload,
          content: artifact.content,
          sha256: artifact.meta.blobRef,
        }),
      )
      if (
        asset.provider !== target.provider ||
        asset.repository !== target.repository ||
        asset.releaseId !== target.releaseId
      ) {
        throw new Error(
          'PR attachment host returned a deletion handle for a different target',
        )
      }
    } catch (error) {
      await recordHostingFailure(deps, events, designation, error)
      continue
    }

    const assetRef =
      `${asset.provider}:${asset.repository}:release/${asset.releaseId}:` +
      `asset/${asset.assetId}`
    let event: EventEnvelope<'pr-attachment.hosted'>
    try {
      event = await deps.store.append(deps.env.build, {
        actor: KERNEL,
        type: 'pr-attachment.hosted',
        payload: { designationSeq: designation.seq, asset },
      })
    } catch (error) {
      // A late attachment has no phase retry after its external upload. Leave
      // an exact cleanup pointer before preserving finalize's throw-and-adopt
      // behavior for this upload/write crash window.
      await recordHostingFailure(
        deps,
        events,
        designation,
        new Error(
          `public copy ${assetRef} was uploaded, but its durable hosted fact ` +
            `could not be recorded: ${errorMessage(error)}`,
        ),
        [assetRef],
      )
      throw error
    }
    events.push(event)
    hosted.set(designation.seq, event)
  }
}
