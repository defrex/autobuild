import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  hostedPrAttachmentAssetSchema,
  prAttachmentSchema,
  prImageHostSchema,
  type HostedPrAttachmentAsset,
} from '../../ontology'
import type {
  PrAttachmentHosting,
  PrAttachmentReclaimRequest,
  PrAttachmentUploadRequest,
} from '../types'
import { GitHubApiError, type GitHubRequest } from './github-transport'

const repositoryJson = z
  .object({
    private: z.boolean().optional(),
    visibility: z.enum(['public', 'private', 'internal']).optional(),
  })
  .refine(
    (repository) => repository.private !== undefined || repository.visibility !== undefined,
    'GitHub repository response must expose private or visibility',
  )

const releaseJson = z.object({
  id: z.number().int().positive(),
  draft: z.boolean(),
  published_at: z.string().min(1).nullable(),
  upload_url: z.string().url(),
  immutable: z.boolean(),
})

const releaseAssetJson = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  state: z.string().min(1),
  content_type: z.string().min(1),
  size: z.number().int().nonnegative(),
  digest: z.string().nullable().optional(),
  browser_download_url: z.string().url(),
})
type ReleaseAsset = z.infer<typeof releaseAssetJson>

const SHA256 = /^[0-9a-f]{64}$/
/** Bounded page walk for the release-asset listing. */
const ASSET_PAGE_SIZE = 100
const MAX_ASSET_PAGES = 20
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function repositoryParts(repository: string): [string, string] {
  prImageHostSchema.shape.repository.parse(repository)
  return repository.split('/') as [string, string]
}

function repositoryEndpoint(repository: string): string {
  const [owner, name] = repositoryParts(repository)
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** Hash all identity inputs with explicit separators. Only a short,
 * validated extension survives from the user-controlled filename. */
export function githubPrAttachmentAssetName(
  request: Pick<PrAttachmentUploadRequest, 'prUrl' | 'attachment' | 'sha256'>,
): string {
  const { artifact, filename, mediaType } = request.attachment
  const extension = filename.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase()
  const digest = createHash('sha256')
    .update(request.prUrl)
    .update('\0')
    .update(artifact.kind)
    .update('\0')
    .update(String(artifact.rev))
    .update('\0')
    .update(filename)
    .update('\0')
    .update(mediaType)
    .update('\0')
    .update(request.sha256)
    .digest('hex')
  return `autobuild-attachment-${digest}${extension === undefined ? '' : `.${extension}`}`
}

function uploadEndpoint(uploadUrl: string, name: string): string {
  const base = uploadUrl.replace(/\{[^}]*\}$/, '')
  return `${base}${base.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}`
}

export class GitHubPrAttachmentHosting implements PrAttachmentHosting {
  private readonly transport: GitHubRequest
  private readonly requestTimeoutMs: number
  /** One GitHubForge instance serves one plumbing operation in production;
   * share the target probe across that operation's attachment uploads. */
  private readonly targetValidations = new Map<string, Promise<z.infer<typeof releaseJson>>>()

  constructor(opts: { transport: GitHubRequest; requestTimeoutMs?: number }) {
    this.transport = opts.transport
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /** One bounded transport call with the class's request timeout applied. */
  private call(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; raw?: Uint8Array },
  ): Promise<{
    status: number
    headers: Record<string, string>
    json?: unknown
    bytes?: Uint8Array
  }> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs)
    return this.transport(method, path, {
      ...(opts?.headers !== undefined ? { headers: opts.headers } : {}),
      ...(opts?.raw !== undefined ? { raw: opts.raw } : {}),
      signal,
    })
  }

  private parseJson<S extends z.ZodType>(
    schema: S,
    response: { json?: unknown },
    what: string,
  ): z.infer<S> {
    const parsed = schema.safeParse(response.json)
    if (!parsed.success) {
      throw new Error(`unexpected GitHub response for ${what}: ${parsed.error.message}`)
    }
    return parsed.data
  }

  private async validateTarget(
    request: PrAttachmentUploadRequest,
  ): Promise<z.infer<typeof releaseJson>> {
    const target = prImageHostSchema.parse(request.target)
    const root = repositoryEndpoint(target.repository)
    const repository = this.parseJson(
      repositoryJson,
      await this.call('GET', root),
      `repository read of ${target.repository}`,
    )
    if (
      repository.private === true ||
      (repository.visibility !== undefined && repository.visibility !== 'public')
    ) {
      throw new Error(
        `PR attachment host ${target.repository} is private; GitHub cannot render authenticated release assets inline`,
      )
    }

    const release = this.parseJson(
      releaseJson,
      await this.call('GET', `${root}/releases/${target.releaseId}`),
      `release read of ${target.repository}#${target.releaseId}`,
    )
    if (release.id !== target.releaseId) {
      throw new Error(
        `PR attachment host returned release ${release.id}, expected ${target.releaseId}`,
      )
    }
    if (release.draft || release.published_at === null) {
      throw new Error(
        `PR attachment host release ${target.repository}#${target.releaseId} is not published`,
      )
    }
    if (release.immutable === true) {
      throw new Error(
        `PR attachment host release ${target.repository}#${target.releaseId} is immutable`,
      )
    }
    return release
  }

  private validatedTarget(
    request: PrAttachmentUploadRequest,
  ): Promise<z.infer<typeof releaseJson>> {
    const key = `${request.target.repository}\0${request.target.releaseId}`
    const existing = this.targetValidations.get(key)
    if (existing !== undefined) return existing
    const pending = this.validateTarget(request).catch((error) => {
      this.targetValidations.delete(key)
      throw error
    })
    this.targetValidations.set(key, pending)
    return pending
  }

  private async listAssets(request: PrAttachmentUploadRequest): Promise<ReleaseAsset[]> {
    const root = repositoryEndpoint(request.target.repository)
    const assets: ReleaseAsset[] = []
    for (let page = 1; page <= MAX_ASSET_PAGES; page += 1) {
      const response = await this.call(
        'GET',
        `${root}/releases/${request.target.releaseId}/assets?per_page=${ASSET_PAGE_SIZE}&page=${page}`,
      )
      const batch = this.parseJson(
        z.array(releaseAssetJson),
        response,
        `asset listing of ${request.target.repository}#${request.target.releaseId}`,
      )
      assets.push(...batch)
      if (batch.length < ASSET_PAGE_SIZE) return assets
    }
    throw new Error(
      `asset listing of ${request.target.repository}#${request.target.releaseId} exceeded ${MAX_ASSET_PAGES} pages`,
    )
  }

  private assertCompatibleAsset(
    asset: ReleaseAsset,
    expected: { name: string; mediaType: string; size: number; digest: string },
    target: PrAttachmentUploadRequest['target'],
  ): HostedPrAttachmentAsset {
    if (asset.name !== expected.name) {
      throw new Error(
        `PR attachment asset has name ${JSON.stringify(asset.name)}, expected ${JSON.stringify(expected.name)}`,
      )
    }
    if (asset.state !== 'uploaded') {
      throw new Error(
        `PR attachment asset ${asset.name} has state ${JSON.stringify(asset.state)}, expected "uploaded"`,
      )
    }
    if (asset.content_type !== expected.mediaType) {
      throw new Error(
        `PR attachment asset ${asset.name} has content type ${JSON.stringify(asset.content_type)}, expected ${JSON.stringify(expected.mediaType)}`,
      )
    }
    if (asset.size !== expected.size) {
      throw new Error(
        `PR attachment asset ${asset.name} has size ${asset.size}, expected ${expected.size}`,
      )
    }
    if (asset.digest != null && asset.digest !== expected.digest) {
      throw new Error(
        `PR attachment asset ${asset.name} has digest ${JSON.stringify(asset.digest)}, expected ${JSON.stringify(expected.digest)}`,
      )
    }
    return hostedPrAttachmentAssetSchema.parse({
      provider: 'github-release',
      repository: target.repository,
      releaseId: target.releaseId,
      assetId: asset.id,
      url: asset.browser_download_url,
    })
  }

  async upload(request: PrAttachmentUploadRequest): Promise<HostedPrAttachmentAsset> {
    const target = prImageHostSchema.parse(request.target)
    if (!SHA256.test(request.sha256)) {
      throw new Error('PR attachment upload requires a full lowercase SHA-256 blob ref')
    }
    const actual = createHash('sha256').update(request.content).digest('hex')
    if (actual !== request.sha256) {
      throw new Error(`PR attachment bytes hash to ${actual}, not expected blob ${request.sha256}`)
    }
    const attachment = prAttachmentSchema.parse(request.attachment)
    if (!attachment.mediaType.startsWith('image/')) {
      throw new Error(
        `PR attachment image host accepts only image/* media, got ${JSON.stringify(attachment.mediaType)}`,
      )
    }
    if (request.prUrl.trim() === '') {
      throw new Error('PR attachment upload PR URL must be non-blank')
    }

    const normalized = { ...request, target, attachment }
    const release = await this.validatedTarget(normalized)
    const filename = githubPrAttachmentAssetName(normalized)
    const expected = {
      name: filename,
      mediaType: normalized.attachment.mediaType,
      size: normalized.content.byteLength,
      digest: `sha256:${normalized.sha256}`,
    }
    const existing = (await this.listAssets(normalized)).find((asset) => asset.name === filename)

    if (existing !== undefined) {
      // GitHub may leave an incomplete starter/open row when an upload dies.
      // It is safe to remove because its deterministic name belongs to this
      // exact PR/attachment/blob identity; an uploaded mismatch is never clobbered.
      if (existing.state === 'starter' || existing.state === 'open') {
        await this.deleteAsset(target.repository, existing.id)
      } else {
        return this.assertCompatibleAsset(existing, expected, target)
      }
    }

    try {
      const uploaded = this.parseJson(
        releaseAssetJson,
        await this.call('POST', uploadEndpoint(release.upload_url, filename), {
          headers: { 'Content-Type': normalized.attachment.mediaType },
          raw: normalized.content,
        }),
        'PR attachment upload',
      )
      if (uploaded.name !== filename) {
        throw new Error(
          `PR attachment upload returned name ${JSON.stringify(uploaded.name)}, expected ${JSON.stringify(filename)}`,
        )
      }
      return this.assertCompatibleAsset(uploaded, expected, target)
    } catch (uploadError) {
      // A lost response may still have committed the external write.
      // Reconcile once before degrading finalize: adopt a compatible upload,
      // or remove the incomplete starter/open remnant so failed attempts
      // cannot accumulate untracked release storage.
      let candidate: ReleaseAsset | undefined
      try {
        candidate = (await this.listAssets(normalized)).find((asset) => asset.name === filename)
      } catch {
        throw uploadError
      }
      if (candidate === undefined) throw uploadError
      if (candidate.state === 'starter' || candidate.state === 'open') {
        try {
          await this.deleteAsset(target.repository, candidate.id)
        } catch {
          // Preserve the primary upload error; its deterministic name keeps
          // the remnant identifiable to a later explicit retry or cleanup.
        }
        throw uploadError
      }
      return this.assertCompatibleAsset(candidate, expected, target)
    }
  }

  private async deleteAsset(repository: string, assetId: number): Promise<void> {
    try {
      await this.call('DELETE', `${repositoryEndpoint(repository)}/releases/assets/${assetId}`)
    } catch (error) {
      // Absent (already deleted) is the reclaim goal met; anything else is a
      // real failure.
      if (error instanceof GitHubApiError && error.status === 404) return
      throw new Error(
        `PR attachment asset delete failed for ${repository}#${assetId}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
  }

  async reclaim(request: PrAttachmentReclaimRequest): Promise<void> {
    const asset = hostedPrAttachmentAssetSchema.parse(request.asset)
    await this.deleteAsset(asset.repository, asset.assetId)
  }
}
