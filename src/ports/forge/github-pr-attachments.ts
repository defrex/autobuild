import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

export interface PrAttachmentExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** The production GitHub exec seam accepts cancellation; existing test seams
 * may ignore the optional signal without changing their shape. */
export type PrAttachmentExec = (
  cmd: string[],
  opts: { cwd: string; signal?: AbortSignal },
) => Promise<PrAttachmentExecResult>

export interface PrAttachmentTempFile {
  path: string
  cleanup(): Promise<void>
}

export type PrAttachmentTempFileWriter = (content: Uint8Array) => Promise<PrAttachmentTempFile>

export const defaultPrAttachmentTempFileWriter: PrAttachmentTempFileWriter = async (content) => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-pr-attachment-'))
  const path = join(dir, 'attachment.bin')
  try {
    await writeFile(path, content)
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

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

const pagedAssetsJson = z.union([z.array(releaseAssetJson), z.array(z.array(releaseAssetJson))])

const SHA256 = /^[0-9a-f]{64}$/
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000

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

function flattenAssets(value: z.infer<typeof pagedAssetsJson>): ReleaseAsset[] {
  if (value.length === 0) return []
  return Array.isArray(value[0]) ? (value as ReleaseAsset[][]).flat() : (value as ReleaseAsset[])
}

function isNotFound(result: PrAttachmentExecResult): boolean {
  return (
    result.exitCode !== 0 &&
    /(?:HTTP\s*404|status(?: code)?\s*[:=]?\s*404|\b404\s+Not Found\b|Not Found\s*\(HTTP 404\))/i.test(
      `${result.stderr}\n${result.stdout}`,
    )
  )
}

export class GitHubPrAttachmentHosting implements PrAttachmentHosting {
  private readonly exec: PrAttachmentExec
  private readonly writeTempFile: PrAttachmentTempFileWriter
  private readonly commandTimeoutMs: number
  /** One GitHubForge instance serves one plumbing operation in production;
   * share the target probe across that operation's attachment uploads. */
  private readonly targetValidations = new Map<string, Promise<z.infer<typeof releaseJson>>>()

  constructor(opts: {
    exec: PrAttachmentExec
    writeTempFile?: PrAttachmentTempFileWriter
    commandTimeoutMs?: number
  }) {
    this.exec = opts.exec
    this.writeTempFile = opts.writeTempFile ?? defaultPrAttachmentTempFileWriter
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  }

  private async execute(cmd: string[], cwd: string): Promise<PrAttachmentExecResult> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          controller.abort()
          reject(
            new Error(
              `PR attachment GitHub command timed out after ${this.commandTimeoutMs}ms: ${cmd.join(' ')}`,
            ),
          )
        },
        Math.max(0, this.commandTimeoutMs),
      )
    })
    try {
      return await Promise.race([this.exec(cmd, { cwd, signal: controller.signal }), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async run(cmd: string[], cwd: string): Promise<string> {
    const result = await this.execute(cmd, cwd)
    if (result.exitCode !== 0) {
      throw new Error(
        `PR attachment forge command failed (exit ${result.exitCode}): ${cmd.join(' ')}\n` +
          (result.stderr.trim() || result.stdout.trim()),
      )
    }
    return result.stdout
  }

  private parseJson<S extends z.ZodType>(schema: S, stdout: string, cmd: string[]): z.infer<S> {
    try {
      return schema.parse(JSON.parse(stdout))
    } catch (error) {
      throw new Error(`unexpected output from \`${cmd.join(' ')}\`: ${errorMessage(error)}`)
    }
  }

  private async validateTarget(
    request: PrAttachmentUploadRequest,
  ): Promise<z.infer<typeof releaseJson>> {
    const target = prImageHostSchema.parse(request.target)
    const root = repositoryEndpoint(target.repository)
    const repoCmd = ['gh', 'api', root]
    const repository = this.parseJson(
      repositoryJson,
      await this.run(repoCmd, request.workspacePath),
      repoCmd,
    )
    if (
      repository.private === true ||
      (repository.visibility !== undefined && repository.visibility !== 'public')
    ) {
      throw new Error(
        `PR attachment host ${target.repository} is private; GitHub cannot render authenticated release assets inline`,
      )
    }

    const releaseCmd = ['gh', 'api', `${root}/releases/${target.releaseId}`]
    const release = this.parseJson(
      releaseJson,
      await this.run(releaseCmd, request.workspacePath),
      releaseCmd,
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
    const cmd = [
      'gh',
      'api',
      '--paginate',
      '--slurp',
      `${root}/releases/${request.target.releaseId}/assets?per_page=100`,
    ]
    const parsed = this.parseJson(pagedAssetsJson, await this.run(cmd, request.workspacePath), cmd)
    return flattenAssets(parsed)
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
        await this.deleteAsset(normalized.workspacePath, target.repository, existing.id)
      } else {
        return this.assertCompatibleAsset(existing, expected, target)
      }
    }

    const temp = await this.writeTempFile(normalized.content)
    try {
      const cmd = [
        'gh',
        'api',
        '--method',
        'POST',
        uploadEndpoint(release.upload_url, filename),
        '--header',
        `Content-Type: ${normalized.attachment.mediaType}`,
        '--input',
        temp.path,
      ]
      try {
        const uploaded = this.parseJson(
          releaseAssetJson,
          await this.run(cmd, normalized.workspacePath),
          cmd,
        )
        if (uploaded.name !== filename) {
          throw new Error(
            `PR attachment upload returned name ${JSON.stringify(uploaded.name)}, expected ${JSON.stringify(filename)}`,
          )
        }
        return this.assertCompatibleAsset(uploaded, expected, target)
      } catch (uploadError) {
        // A killed gh process or lost response may still have committed the
        // external write. Reconcile once before degrading finalize: adopt a
        // compatible upload, or remove the incomplete starter/open remnant so
        // failed attempts cannot accumulate untracked release storage.
        let candidate: ReleaseAsset | undefined
        try {
          candidate = (await this.listAssets(normalized)).find((asset) => asset.name === filename)
        } catch {
          throw uploadError
        }
        if (candidate === undefined) throw uploadError
        if (candidate.state === 'starter' || candidate.state === 'open') {
          try {
            await this.deleteAsset(normalized.workspacePath, target.repository, candidate.id)
          } catch {
            // Preserve the primary upload error; its deterministic name keeps
            // the remnant identifiable to a later explicit retry or cleanup.
          }
          throw uploadError
        }
        return this.assertCompatibleAsset(candidate, expected, target)
      }
    } finally {
      try {
        await temp.cleanup()
      } catch {
        // Never turn a successful external upload into an untracked asset by
        // masking its deletion handle with an OS-temp cleanup error.
      }
    }
  }

  private async deleteAsset(
    workspacePath: string,
    repository: string,
    assetId: number,
  ): Promise<void> {
    const cmd = [
      'gh',
      'api',
      '--method',
      'DELETE',
      `${repositoryEndpoint(repository)}/releases/assets/${assetId}`,
    ]
    const result = await this.execute(cmd, workspacePath)
    if (result.exitCode === 0 || isNotFound(result)) return
    throw new Error(
      `PR attachment forge command failed (exit ${result.exitCode}): ${cmd.join(' ')}\n` +
        (result.stderr.trim() || result.stdout.trim()),
    )
  }

  async reclaim(request: PrAttachmentReclaimRequest): Promise<void> {
    const asset = hostedPrAttachmentAssetSchema.parse(request.asset)
    await this.deleteAsset(request.workspacePath, asset.repository, asset.assetId)
  }
}
