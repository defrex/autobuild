import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { PrAttachmentUploadRequest } from '../types'
import { GitHubPrAttachmentHosting } from './github-pr-attachments'
import type { GitHubRequest } from './github-transport'

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

describe('GitHubPrAttachmentHosting.upload', () => {
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
})
