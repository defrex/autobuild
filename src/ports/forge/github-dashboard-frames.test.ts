import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { DashboardFrameUploadRequest } from '../types'
import {
  GitHubDashboardFrameHosting,
  githubDashboardFrameAssetName,
  type DashboardFrameExec,
  type DashboardFrameExecResult,
  type DashboardFrameTempFileWriter,
} from './github-dashboard-frames'

interface Call {
  cmd: string[]
  cwd: string
  signal?: AbortSignal
}

function scripted(responses: Partial<DashboardFrameExecResult>[]) {
  const calls: Call[] = []
  const queue = [...responses]
  const exec: DashboardFrameExec = async (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd, signal: opts.signal })
    const next = queue.shift() ?? {}
    return { stdout: '', stderr: '', exitCode: 0, ...next }
  }
  return { exec, calls }
}

const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const sha256 = createHash('sha256').update(bytes).digest('hex')
const request: DashboardFrameUploadRequest = {
  workspacePath: '/ws/build',
  target: {
    provider: 'github-release',
    repository: 'acme/review-assets',
    releaseId: 42,
  },
  prUrl: 'https://github.com/acme/app/pull/9',
  name: 'mixed-wide',
  content: bytes,
  sha256,
}
const filename = githubDashboardFrameAssetName(request)
const downloadUrl =
  `https://github.com/acme/review-assets/releases/download/review/${filename}`

const PUBLIC = { stdout: JSON.stringify({ private: false }) }
const RELEASE = {
  stdout: JSON.stringify({
    id: 42,
    draft: false,
    published_at: '2026-01-01T00:00:00Z',
    immutable: false,
    upload_url:
      'https://uploads.github.com/repos/acme/review-assets/releases/42/assets{?name,label}',
  }),
}

function asset(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 77,
    name: filename,
    state: 'uploaded',
    content_type: 'image/png',
    size: bytes.byteLength,
    digest: `sha256:${sha256}`,
    browser_download_url: downloadUrl,
    ...overrides,
  })
}

function tempWriter() {
  const writes: Uint8Array[] = []
  let cleanups = 0
  const writer: DashboardFrameTempFileWriter = async (content) => {
    writes.push(content.slice())
    return {
      path: '/tmp/frame.png',
      cleanup: async () => {
        cleanups += 1
      },
    }
  }
  return { writer, writes, cleanups: () => cleanups }
}

describe('GitHubDashboardFrameHosting.upload', () => {
  test('validates the public release, pages assets, uploads exact PNG bytes, and returns a durable handle', async () => {
    const { exec, calls } = scripted([
      PUBLIC,
      RELEASE,
      { stdout: '[[]]' },
      { stdout: asset() },
    ])
    const temp = tempWriter()
    const hosting = new GitHubDashboardFrameHosting({
      exec,
      writeTempFile: temp.writer,
    })

    expect(await hosting.upload(request)).toEqual({
      provider: 'github-release',
      repository: 'acme/review-assets',
      releaseId: 42,
      assetId: 77,
      url: downloadUrl,
    })
    expect(temp.writes).toEqual([bytes])
    expect(temp.cleanups()).toBe(1)
    expect(calls.map((call) => call.cmd)).toEqual([
      ['gh', 'api', 'repos/acme/review-assets'],
      ['gh', 'api', 'repos/acme/review-assets/releases/42'],
      [
        'gh',
        'api',
        '--paginate',
        '--slurp',
        'repos/acme/review-assets/releases/42/assets?per_page=100',
      ],
      [
        'gh',
        'api',
        '--method',
        'POST',
        `https://uploads.github.com/repos/acme/review-assets/releases/42/assets?name=${filename}`,
        '--header',
        'Content-Type: image/png',
        '--input',
        '/tmp/frame.png',
      ],
    ])
    expect(calls.every((call) => call.cwd === '/ws/build')).toBe(true)
  })

  test('adopts a compatible asset found on a later paginated page', async () => {
    const { exec, calls } = scripted([
      PUBLIC,
      RELEASE,
      {
        stdout: JSON.stringify([
          [],
          [JSON.parse(asset())],
        ]),
      },
    ])
    const temp = tempWriter()
    const hosting = new GitHubDashboardFrameHosting({
      exec,
      writeTempFile: temp.writer,
    })

    expect((await hosting.upload(request)).assetId).toBe(77)
    expect(calls).toHaveLength(3)
    expect(temp.writes).toEqual([])
  })

  test('rejects private, unpublished, and immutable targets before upload', async () => {
    const cases: Partial<DashboardFrameExecResult>[][] = [
      [{ stdout: JSON.stringify({ private: true }) }],
      [
        PUBLIC,
        {
          stdout: JSON.stringify({
            id: 42,
            draft: true,
            published_at: null,
            immutable: false,
            upload_url: 'https://uploads.github.com/release{?name}',
          }),
        },
      ],
      [
        PUBLIC,
        {
          stdout: JSON.stringify({
            id: 42,
            draft: false,
            published_at: '2026-01-01',
            immutable: true,
            upload_url: 'https://uploads.github.com/release{?name}',
          }),
        },
      ],
    ]
    for (const responses of cases) {
      const { exec } = scripted(responses)
      const hosting = new GitHubDashboardFrameHosting({ exec })
      await expect(hosting.upload(request)).rejects.toThrow(
        /private|not published|immutable/,
      )
    }
  })

  test('never adopts or clobbers an uploaded asset with mismatched identity', async () => {
    for (const mismatch of [
      { content_type: 'application/octet-stream' },
      { size: bytes.byteLength + 1 },
      { digest: `sha256:${'0'.repeat(64)}` },
      { state: 'mystery' },
    ]) {
      const { exec, calls } = scripted([
        PUBLIC,
        RELEASE,
        { stdout: JSON.stringify([[JSON.parse(asset(mismatch))]]) },
      ])
      const hosting = new GitHubDashboardFrameHosting({ exec })
      await expect(hosting.upload(request)).rejects.toThrow(
        /content type|size|digest|state/,
      )
      expect(calls).toHaveLength(3)
    }
  })

  test('deletes a starter remnant before retrying the binary upload', async () => {
    const { exec, calls } = scripted([
      PUBLIC,
      RELEASE,
      { stdout: JSON.stringify([[JSON.parse(asset({ state: 'starter' }))]]) },
      {},
      { stdout: asset({ id: 88 }) },
    ])
    const temp = tempWriter()
    const hosting = new GitHubDashboardFrameHosting({
      exec,
      writeTempFile: temp.writer,
    })
    expect((await hosting.upload(request)).assetId).toBe(88)
    expect(calls[3]!.cmd).toEqual([
      'gh',
      'api',
      '--method',
      'DELETE',
      'repos/acme/review-assets/releases/assets/77',
    ])
    expect(calls[4]!.cmd).toContain('POST')
  })

  test('reconciles an ambiguous upload error by adopting the committed asset', async () => {
    const { exec, calls } = scripted([
      PUBLIC,
      RELEASE,
      { stdout: '[[]]' },
      { exitCode: 1, stderr: 'connection closed after request body' },
      { stdout: JSON.stringify([[JSON.parse(asset())]]) },
    ])
    const temp = tempWriter()
    const hosting = new GitHubDashboardFrameHosting({
      exec,
      writeTempFile: temp.writer,
    })

    expect((await hosting.upload(request)).assetId).toBe(77)
    expect(calls).toHaveLength(5)
    expect(temp.cleanups()).toBe(1)
  })

  test('removes a starter created by a failed upload before reporting fallback', async () => {
    const { exec, calls } = scripted([
      PUBLIC,
      RELEASE,
      { stdout: '[[]]' },
      { exitCode: 1, stderr: 'upload interrupted' },
      { stdout: JSON.stringify([[JSON.parse(asset({ state: 'starter' }))]]) },
      {},
    ])
    const temp = tempWriter()
    const hosting = new GitHubDashboardFrameHosting({
      exec,
      writeTempFile: temp.writer,
    })

    await expect(hosting.upload(request)).rejects.toThrow('upload interrupted')
    expect(calls.at(-1)!.cmd).toEqual([
      'gh',
      'api',
      '--method',
      'DELETE',
      'repos/acme/review-assets/releases/assets/77',
    ])
    expect(temp.cleanups()).toBe(1)
  })

  test('checks the supplied blob hash before any GitHub call', async () => {
    const { exec, calls } = scripted([])
    const hosting = new GitHubDashboardFrameHosting({ exec })
    await expect(
      hosting.upload({ ...request, sha256: '0'.repeat(64) }),
    ).rejects.toThrow(/bytes hash to/)
    expect(calls).toEqual([])
  })

  test('an internal deadline aborts a hung gh child', async () => {
    let aborted = false
    const exec: DashboardFrameExec = (_cmd, opts) =>
      new Promise((_resolve) => {
        opts.signal?.addEventListener('abort', () => {
          aborted = true
        })
      })
    const hosting = new GitHubDashboardFrameHosting({
      exec,
      commandTimeoutMs: 1,
    })
    await expect(hosting.upload(request)).rejects.toThrow(/timed out/)
    expect(aborted).toBe(true)
  })
})

describe('GitHubDashboardFrameHosting.reclaim', () => {
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

  test('deletes by durable repository/asset id from the supplied cwd', async () => {
    const { exec, calls } = scripted([{}])
    const hosting = new GitHubDashboardFrameHosting({ exec })
    await hosting.reclaim(reclaim)
    expect(calls).toEqual([
      {
        cmd: [
          'gh',
          'api',
          '--method',
          'DELETE',
          'repos/acme/review-assets/releases/assets/77',
        ],
        cwd: '/repos/main',
        signal: expect.any(AbortSignal),
      },
    ])
  })

  test('treats an HTTP 404 as successful idempotent cleanup', async () => {
    const { exec } = scripted([
      { exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' },
    ])
    const hosting = new GitHubDashboardFrameHosting({ exec })
    await expect(hosting.reclaim(reclaim)).resolves.toBeUndefined()
  })
})
