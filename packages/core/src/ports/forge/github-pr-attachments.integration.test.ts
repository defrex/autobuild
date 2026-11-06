import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { PrAttachmentUploadRequest } from '../types'
import { GitHubPrAttachmentHosting, githubPrAttachmentAssetName } from './github-pr-attachments'
import { GitHubApiError, type GitHubRequest, type GitHubRequestOpts } from './github-transport'

interface ApiCall {
  method: string
  path: string
  opts?: GitHubRequestOpts
}

interface Scripted {
  status?: number
  json?: unknown
  bytes?: Uint8Array
}

function makeTransport(responses: Scripted[] = []) {
  const calls: ApiCall[] = []
  const queue = [...responses]
  const transport: GitHubRequest = async (method, path, opts) => {
    calls.push({ method, path, ...(opts !== undefined ? { opts } : {}) })
    const next = queue.shift() ?? {}
    const status = next.status ?? 200
    if (status >= 300) {
      throw new GitHubApiError(
        status,
        (next.json as { message?: string } | undefined)?.message ?? 'GitHub API error',
        next.json,
      )
    }
    return {
      status,
      headers: {},
      ...(next.json !== undefined ? { json: next.json } : {}),
      ...(next.bytes !== undefined ? { bytes: next.bytes } : {}),
    }
  }
  return { transport, calls }
}

const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const sha256 = createHash('sha256').update(bytes).digest('hex')
const request: PrAttachmentUploadRequest = {
  workspacePath: '/ws/build',
  target: {
    provider: 'github-release',
    repository: 'acme/review-assets',
    releaseId: 42,
  },
  prUrl: 'https://github.com/acme/app/pull/9',
  attachment: {
    artifact: { kind: 'visual:screenshot', rev: 2 },
    filename: 'screenshot.png',
    mediaType: 'image/png',
  },
  content: bytes,
  sha256,
}
const filename = githubPrAttachmentAssetName(request)
const downloadUrl = `https://github.com/acme/review-assets/releases/download/review/${filename}`

const PUBLIC = { json: { private: false } }
const RELEASE = {
  json: {
    id: 42,
    draft: false,
    published_at: '2026-01-01T00:00:00Z',
    immutable: false,
    upload_url:
      'https://uploads.github.com/repos/acme/review-assets/releases/42/assets{?name,label}',
  },
}

function asset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 77,
    name: filename,
    state: 'uploaded',
    content_type: 'image/png',
    size: bytes.byteLength,
    digest: `sha256:${sha256}`,
    browser_download_url: downloadUrl,
    ...overrides,
  }
}

describe('GitHubPrAttachmentHosting.upload', () => {
  test('validates the public release, lists assets, uploads exact PNG bytes, and returns a durable handle', async () => {
    const { transport, calls } = makeTransport([PUBLIC, RELEASE, { json: [] }, { json: asset() }])
    const hosting = new GitHubPrAttachmentHosting({ transport })

    expect(await hosting.upload(request)).toEqual({
      provider: 'github-release',
      repository: 'acme/review-assets',
      releaseId: 42,
      assetId: 77,
      url: downloadUrl,
    })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET repos/acme/review-assets',
      'GET repos/acme/review-assets/releases/42',
      'GET repos/acme/review-assets/releases/42/assets?per_page=100&page=1',
      `POST https://uploads.github.com/repos/acme/review-assets/releases/42/assets?name=${filename}`,
    ])
    expect(calls[3]?.opts?.raw).toEqual(bytes)
    expect(calls[3]?.opts?.headers).toEqual({ 'Content-Type': 'image/png' })
  })

  test('adopts a compatible asset found in the listing instead of uploading', async () => {
    const { transport, calls } = makeTransport([PUBLIC, RELEASE, { json: [asset()] }])
    const hosting = new GitHubPrAttachmentHosting({ transport })
    expect((await hosting.upload(request)).assetId).toBe(77)
    expect(calls).toHaveLength(3)
  })

  test('rejects private, unpublished, and immutable targets before upload', async () => {
    const cases: Scripted[][] = [
      [{ json: { private: true } }],
      [
        PUBLIC,
        {
          json: {
            id: 42,
            draft: true,
            published_at: null,
            immutable: false,
            upload_url: 'https://uploads.github.com/release{?name}',
          },
        },
      ],
      [
        PUBLIC,
        {
          json: {
            id: 42,
            draft: false,
            published_at: '2026-01-01',
            immutable: true,
            upload_url: 'https://uploads.github.com/release{?name}',
          },
        },
      ],
    ]
    for (const responses of cases) {
      const { transport } = makeTransport(responses)
      const hosting = new GitHubPrAttachmentHosting({ transport })
      await expect(hosting.upload(request)).rejects.toThrow(/private|not published|immutable/)
    }
  })

  test('never adopts or clobbers an uploaded asset with mismatched identity', async () => {
    for (const mismatch of [
      { content_type: 'application/octet-stream' },
      { size: bytes.byteLength + 1 },
      { digest: `sha256:${'0'.repeat(64)}` },
      { state: 'mystery' },
    ]) {
      const { transport, calls } = makeTransport([PUBLIC, RELEASE, { json: [asset(mismatch)] }])
      const hosting = new GitHubPrAttachmentHosting({ transport })
      await expect(hosting.upload(request)).rejects.toThrow(/content type|size|digest|state/)
      expect(calls).toHaveLength(3)
    }
  })

  test('deletes a starter remnant before retrying the binary upload', async () => {
    const { transport, calls } = makeTransport([
      PUBLIC,
      RELEASE,
      { json: [asset({ state: 'starter' })] },
      {},
      { json: asset({ id: 88 }) },
    ])
    const hosting = new GitHubPrAttachmentHosting({ transport })
    expect((await hosting.upload(request)).assetId).toBe(88)
    expect(calls[3]?.method).toBe('DELETE')
    expect(calls[3]?.path).toBe('repos/acme/review-assets/releases/assets/77')
    expect(calls[4]?.method).toBe('POST')
  })

  test('reconciles an ambiguous upload error by adopting the committed asset', async () => {
    const { transport, calls } = makeTransport([
      PUBLIC,
      RELEASE,
      { json: [] },
      { status: 500, json: { message: 'connection closed after request body' } },
      { json: [asset()] },
    ])
    const hosting = new GitHubPrAttachmentHosting({ transport })

    expect((await hosting.upload(request)).assetId).toBe(77)
    expect(calls).toHaveLength(5)
  })

  test('removes a starter created by a failed upload before reporting fallback', async () => {
    const { transport, calls } = makeTransport([
      PUBLIC,
      RELEASE,
      { json: [] },
      { status: 500, json: { message: 'upload interrupted' } },
      { json: [asset({ state: 'starter' })] },
      {},
    ])
    const hosting = new GitHubPrAttachmentHosting({ transport })

    await expect(hosting.upload(request)).rejects.toThrow('upload interrupted')
    expect(calls.at(-1)?.method).toBe('DELETE')
    expect(calls.at(-1)?.path).toBe('repos/acme/review-assets/releases/assets/77')
  })

  test('checks the supplied blob hash before any GitHub call', async () => {
    const { transport, calls } = makeTransport([])
    const hosting = new GitHubPrAttachmentHosting({ transport })
    await expect(hosting.upload({ ...request, sha256: '0'.repeat(64) })).rejects.toThrow(
      /bytes hash to/,
    )
    expect(calls).toEqual([])
  })

  test('applies the request deadline to every call', async () => {
    let aborted = false
    const transport: GitHubRequest = (_method, _path, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })
    const hosting = new GitHubPrAttachmentHosting({ transport, requestTimeoutMs: 1 })
    await expect(hosting.upload(request)).rejects.toThrow()
    expect(aborted).toBe(true)
  })

  test('uses the attachment media type and full identity while retaining only a safe extension', async () => {
    const webpRequest: PrAttachmentUploadRequest = {
      ...request,
      attachment: {
        artifact: { kind: 'visual:card', rev: 4 },
        filename: 'customer card.WEBP',
        mediaType: 'image/webp',
      },
    }
    const webpName = githubPrAttachmentAssetName(webpRequest)
    const webpUrl = `https://example.invalid/${webpName}`
    const { transport, calls } = makeTransport([
      PUBLIC,
      RELEASE,
      { json: [] },
      {
        json: {
          id: 88,
          name: webpName,
          state: 'uploaded',
          content_type: 'image/webp',
          size: bytes.byteLength,
          digest: `sha256:${sha256}`,
          browser_download_url: webpUrl,
        },
      },
    ])

    expect(await new GitHubPrAttachmentHosting({ transport }).upload(webpRequest)).toMatchObject({
      assetId: 88,
      url: webpUrl,
    })
    expect(webpName).toMatch(/^autobuild-attachment-[0-9a-f]{64}\.webp$/)
    expect(calls.at(-1)?.opts?.headers).toEqual({ 'Content-Type': 'image/webp' })
    expect(
      githubPrAttachmentAssetName({
        ...webpRequest,
        attachment: {
          ...webpRequest.attachment,
          artifact: { kind: 'visual:card', rev: 5 },
        },
      }),
    ).not.toBe(webpName)
  })

  test('rejects non-image requests at the host boundary before any GitHub call', async () => {
    const { transport, calls } = makeTransport([])
    await expect(
      new GitHubPrAttachmentHosting({ transport }).upload({
        ...request,
        attachment: {
          artifact: { kind: 'trace', rev: 0 },
          filename: 'trace.txt',
          mediaType: 'text/plain',
        },
      }),
    ).rejects.toThrow(/only image\/\*/)
    expect(calls).toEqual([])
  })
})

describe('GitHubPrAttachmentHosting.reclaim', () => {
  const reclaim = {
    workspacePath: '/repos/main',
    asset: {
      provider: 'github-release' as const,
      repository: 'acme/review-assets',
      releaseId: 42,
      assetId: 77,
      url: downloadUrl,
    },
  }

  test('deletes by durable repository/asset id', async () => {
    const { transport, calls } = makeTransport([{}])
    const hosting = new GitHubPrAttachmentHosting({ transport })
    await hosting.reclaim(reclaim)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'DELETE repos/acme/review-assets/releases/assets/77',
    ])
  })

  test('treats a 404 as successful idempotent cleanup', async () => {
    const { transport } = makeTransport([{ status: 404, json: { message: 'Not Found' } }])
    const hosting = new GitHubPrAttachmentHosting({ transport })
    await expect(hosting.reclaim(reclaim)).resolves.toBeUndefined()
  })
})
