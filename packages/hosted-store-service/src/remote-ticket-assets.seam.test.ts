/**
 * Ticket assets over the remote store wire (SPEC §7.1, docs/remote-store-
 * protocol.md): token matrix, the advertised deployment ceiling and its
 * client-side enforcement, and the response-side ceiling checks. The
 * store-behavior half runs in the shared contract suite
 * (remote-store.seam.test.ts).
 */
import { describe, expect, test } from 'bun:test'
import {
  effectiveTicketAssetLimits,
  MemoryBuildStore,
  TICKET_ASSET_MAX_BYTES,
  TICKET_ASSET_MAX_ENTRIES,
  TicketAssetValidationError,
  type TicketAssetEntryInput,
} from '@defrex/autobuild/plugin-sdk'
import { AuthError, mintToken, RemoteBuildStore } from '@defrex/autobuild/remote-store'
import { startStoreServer } from './remote-store-server'

const REPO = 'https://github.com/acme/rate-limiter'
const enc = (text: string) => new TextEncoder().encode(text)
const FAR = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000

function fileAsset(name: string, content: Uint8Array) {
  return {
    kind: 'design',
    name,
    layout: 'file' as const,
    entries: [{ type: 'file' as const, path: name, content }],
  }
}

/** A fetch that records every request's method, path, and body length. */
function spyFetch(overrides?: (url: URL) => Response | undefined) {
  const calls: { method: string; path: string; bytes: number }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      bytes: typeof body === 'string' ? new TextEncoder().encode(body).length : 0,
    })
    const forced = overrides?.(url)
    if (forced) return forced
    return fetch(input, init)
  }) as typeof fetch
  return { calls, fetchFn }
}

function harness(opts: { maxTicketAssetRequestBytes?: number; secret?: string } = {}) {
  const backing = new MemoryBuildStore()
  const server = startStoreServer({ store: backing, ...opts })
  return { backing, server }
}

describe('ticket asset routes: token matrix', () => {
  test('repo token for its own repo and admin may use them; build and foreign repo tokens may not', async () => {
    const secret = 's3cret'
    const { server } = harness({ secret })
    try {
      const repoToken = mintToken(secret, {
        resource: { kind: 'repo', id: REPO },
        session: '*',
        exp: FAR,
      })
      const adminToken = mintToken(secret, { build: '*', session: '*', exp: FAR })
      const buildToken = mintToken(secret, { build: 'some-build', session: '*', exp: FAR })
      const otherRepoToken = mintToken(secret, {
        resource: { kind: 'repo', id: 'https://github.com/acme/other' },
        session: '*',
        exp: FAR,
      })
      for (const token of [repoToken, adminToken]) {
        const store = new RemoteBuildStore({ url: server.url, token })
        const meta = await store.putTicketAsset(REPO, 'T-1', fileAsset('a', enc('x')))
        expect(meta.name).toBe('a')
        expect(await store.listTicketAssets(REPO, 'T-1')).toHaveLength(1)
      }
      for (const token of [buildToken, otherRepoToken]) {
        const store = new RemoteBuildStore({ url: server.url, token })
        await expect(store.listTicketAssets(REPO, 'T-1')).rejects.toBeInstanceOf(AuthError)
        await expect(
          store.putTicketAsset(REPO, 'T-1', fileAsset('b', enc('x'))),
        ).rejects.toBeInstanceOf(AuthError)
        await expect(store.ticketAssetLimits(REPO)).rejects.toBeInstanceOf(AuthError)
      }
    } finally {
      await server.stop()
    }
  })
})

describe('ticket asset deployment ceiling', () => {
  test('the server advertises the effective limits and ticketAssetLimits returns them', async () => {
    const ceiling = 4 * 1024 * 1024
    const { server } = harness({ maxTicketAssetRequestBytes: ceiling })
    try {
      const store = new RemoteBuildStore({ url: server.url })
      expect(await store.ticketAssetLimits(REPO)).toEqual(effectiveTicketAssetLimits(ceiling))
      expect((await store.ticketAssetLimits(REPO)).maxBytes).toBe(2_904_960)
      const raw = await fetch(
        `${server.url}/repos/${encodeURIComponent(REPO)}/ticket-asset-limits`,
        {
          headers: {
            'x-autobuild-version': (await import('@defrex/autobuild/remote-store'))
              .AUTOBUILD_VERSION,
            'x-autobuild-protocol-version': (await import('@defrex/autobuild/remote-store'))
              .REMOTE_STORE_PROTOCOL_VERSION,
          },
        },
      )
      expect(await raw.json()).toEqual({
        maxBytes: 2_904_960,
        maxEntries: TICKET_ASSET_MAX_ENTRIES,
        maxRequestBytes: ceiling,
      })
    } finally {
      await server.stop()
    }
  })

  test('without a ceiling the defaults are advertised', async () => {
    const { server } = harness()
    try {
      const store = new RemoteBuildStore({ url: server.url })
      expect(await store.ticketAssetLimits(REPO)).toEqual({
        maxBytes: TICKET_ASSET_MAX_BYTES,
        maxEntries: TICKET_ASSET_MAX_ENTRIES,
      })
    } finally {
      await server.stop()
    }
  })

  test('a server without the limits route (404) is treated as the defaults', async () => {
    const { server } = harness()
    try {
      const { fetchFn, calls } = spyFetch((url) =>
        url.pathname.endsWith('/ticket-asset-limits')
          ? new Response('{"error":"no route","kind":"not-found"}', { status: 404 })
          : undefined,
      )
      const store = new RemoteBuildStore({ url: server.url, fetchFn })
      expect(await store.ticketAssetLimits(REPO)).toEqual({
        maxBytes: TICKET_ASSET_MAX_BYTES,
        maxEntries: TICKET_ASSET_MAX_ENTRIES,
      })
      await store.ticketAssetLimits(REPO)
      expect(calls.filter((call) => call.path.endsWith('/ticket-asset-limits'))).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  test('a bundle over the lowered ceiling is refused locally with no upload request', async () => {
    const { server, backing } = harness({ maxTicketAssetRequestBytes: 4 * 1024 * 1024 })
    try {
      const { fetchFn, calls } = spyFetch()
      const store = new RemoteBuildStore({ url: server.url, fetchFn })
      // Under the 25 MiB default, over the 4 MiB request ceiling.
      const error = await store
        .putTicketAsset(REPO, 'T-1', fileAsset('big.bin', new Uint8Array(5 * 1024 * 1024)))
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(TicketAssetValidationError)
      expect((error as Error).message).toContain(
        "this store's 2904960-byte limit (deployment request ceiling 4194304 bytes)",
      )
      expect(calls.some((call) => call.method === 'POST')).toBe(false)
      expect(await backing.listTicketAssets(REPO, 'T-1', { revisions: true })).toEqual([])
    } finally {
      await server.stop()
    }
  })

  test('raw bytes within maxBytes but an encoded request over the ceiling is refused locally', async () => {
    const { server } = harness()
    try {
      const { fetchFn, calls } = spyFetch((url) =>
        url.pathname.endsWith('/ticket-asset-limits')
          ? new Response(
              JSON.stringify({ maxBytes: 9000, maxEntries: 1000, maxRequestBytes: 12000 }),
            )
          : undefined,
      )
      const store = new RemoteBuildStore({ url: server.url, fetchFn })
      // 9000 raw bytes is 12000 base64 characters before the JSON envelope.
      await expect(
        store.putTicketAsset(REPO, 'T-1', fileAsset('a.bin', new Uint8Array(9000))),
      ).rejects.toThrow(/deployment request ceiling 12000 bytes.*encoded request is \d+ bytes/)
      expect(calls.some((call) => call.method === 'POST')).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test('the server limit error survives the wire when a client does not self-limit', async () => {
    const ceiling = 400_000
    const { server, backing } = harness({ maxTicketAssetRequestBytes: ceiling })
    try {
      const lax = (url: URL) =>
        url.pathname.endsWith('/ticket-asset-limits')
          ? new Response(JSON.stringify({ maxBytes: TICKET_ASSET_MAX_BYTES, maxEntries: 1000 }))
          : undefined
      const { fetchFn } = spyFetch(lax)
      const store = new RemoteBuildStore({ url: server.url, fetchFn })
      const advertised = effectiveTicketAssetLimits(ceiling).maxBytes
      // Fits the request ceiling once encoded, but exceeds the effective maxBytes.
      const over = fileAsset('a.bin', new Uint8Array(advertised + 1))
      const error = await store.putTicketAsset(REPO, 'T-1', over).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(TicketAssetValidationError)
      expect((error as Error).message).toContain(`${advertised}-byte`)
      // Over the request ceiling itself: refused by the server's own body check.
      const huge = fileAsset('b.bin', new Uint8Array(ceiling))
      const hugeError = await store.putTicketAsset(REPO, 'T-1', huge).catch((c: unknown) => c)
      expect(hugeError).toBeInstanceOf(TicketAssetValidationError)
      expect((hugeError as Error).message).toContain(`deployment request ceiling ${ceiling} bytes`)
      expect(await backing.listTicketAssets(REPO, 'T-1', { revisions: true })).toEqual([])
    } finally {
      await server.stop()
    }
  })

  test('a bundle at exactly maxBytes with maximum entries and maximum-length paths fits; one byte over is refused', async () => {
    const ceiling = 4 * 1024 * 1024
    const { server, backing } = harness({ maxTicketAssetRequestBytes: ceiling })
    try {
      const { fetchFn, calls } = spyFetch()
      const store = new RemoteBuildStore({ url: server.url, fetchFn })
      const { maxBytes, maxEntries } = await store.ticketAssetLimits(REPO)
      const perFile = Math.floor(maxBytes / maxEntries)
      const entries: TicketAssetEntryInput[] = []
      let remaining = maxBytes
      for (let index = 0; index < maxEntries; index += 1) {
        // 127 + '/' + 128 bytes: the 256-byte maximum path, unique per entry.
        const path = `${String(index).padStart(127, 'd')}/${String(index).padStart(128, 'f')}`
        const size = index === maxEntries - 1 ? remaining : perFile
        remaining -= size
        entries.push({ type: 'file', path, content: new Uint8Array(size).fill(255) })
      }
      const asset = { kind: 'design', name: 'wide', layout: 'tree' as const, entries }
      const meta = await store.putTicketAsset(REPO, 'T-1', asset)
      expect(meta.size).toBe(maxBytes)
      const upload = calls.find((call) => call.method === 'POST')
      expect(upload?.bytes).toBeLessThanOrEqual(ceiling)

      const last = entries[maxEntries - 1]
      if (last?.type !== 'file') throw new Error('unreachable')
      const over = {
        ...asset,
        name: 'wide2',
        entries: [
          ...entries.slice(0, -1),
          { ...last, content: new Uint8Array(last.content.length + 1) },
        ],
      }
      const before = calls.length
      await expect(store.putTicketAsset(REPO, 'T-1', over)).rejects.toThrow(/byte limit/)
      expect(calls.slice(before).some((call) => call.method === 'POST')).toBe(false)
      expect(await backing.listTicketAssets(REPO, 'T-1')).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })
})

describe('ticket asset downloads under a deployment ceiling', () => {
  test('a directory-only manifest larger than the ceiling fails with the application error', async () => {
    const { server, backing } = harness({ maxTicketAssetRequestBytes: 2048 })
    try {
      // Seeded straight into the backing store, as an older or higher-ceiling
      // store would have accepted it: zero content bytes, a large manifest.
      const entries: TicketAssetEntryInput[] = Array.from({ length: 200 }, (_, index) => ({
        type: 'dir' as const,
        path: `${String(index).padStart(100, 'd')}`,
      }))
      await backing.putTicketAsset(REPO, 'T-1', {
        kind: 'design',
        name: 'dirs',
        layout: 'tree',
        entries,
      })
      const store = new RemoteBuildStore({ url: server.url })
      const error = await store
        .getTicketAsset(REPO, 'T-1', 'design', 'dirs')
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(TicketAssetValidationError)
      expect((error as Error).message).toContain('design/dirs manifest')
      expect((error as Error).message).toContain('2048-byte response ceiling')
    } finally {
      await server.stop()
    }
  })

  test('a file stored under a higher ceiling fails to download, naming file, size and ceiling; the rest still download', async () => {
    const { server, backing } = harness({ maxTicketAssetRequestBytes: 4096 })
    try {
      await backing.putTicketAsset(REPO, 'T-1', {
        kind: 'design',
        name: 'mixed',
        layout: 'tree',
        entries: [
          { type: 'file', path: 'small.txt', content: enc('small') },
          { type: 'file', path: 'big.bin', content: new Uint8Array(6000) },
        ],
      })
      const store = new RemoteBuildStore({ url: server.url })
      const error = await store
        .getTicketAsset(REPO, 'T-1', 'design', 'mixed')
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(TicketAssetValidationError)
      const message = (error as Error).message
      expect(message).toContain('big.bin')
      expect(message).toContain('6000 bytes')
      expect(message).toContain('4096-byte')
      expect(message).toContain('higher ceiling')

      // The manifest and the smaller file are still served.
      const base = `${server.url}/repos/${encodeURIComponent(REPO)}/tickets/T-1/assets`
      const headers = {
        'x-autobuild-version': (await import('@defrex/autobuild/remote-store')).AUTOBUILD_VERSION,
        'x-autobuild-protocol-version': (await import('@defrex/autobuild/remote-store'))
          .REMOTE_STORE_PROTOCOL_VERSION,
      }
      const manifest = await fetch(`${base}?kind=design&name=mixed`, { headers })
      expect(manifest.status).toBe(200)
      const small = await fetch(`${base}/file?kind=design&name=mixed&path=small.txt`, { headers })
      expect(await small.json()).toEqual({ contentBase64: Buffer.from('small').toString('base64') })
    } finally {
      await server.stop()
    }
  })
})

describe('ticket asset mutation responses under a deployment ceiling', () => {
  test('an upload that fits but whose returned manifest does not is refused before anything is stored', async () => {
    const ceiling = 350_000
    const { server, backing } = harness({ maxTicketAssetRequestBytes: ceiling })
    try {
      const store = new RemoteBuildStore({ url: server.url })
      const entries: TicketAssetEntryInput[] = Array.from({ length: 1000 }, (_, index) => ({
        type: 'file' as const,
        path: `${String(index).padStart(127, 'd')}/${String(index).padStart(128, 'f')}`,
        content: new Uint8Array(0),
      }))
      const error = await store
        .putTicketAsset(REPO, 'T-1', { kind: 'design', name: 'wide', layout: 'tree', entries })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(TicketAssetValidationError)
      expect(await backing.listTicketAssets(REPO, 'T-1', { revisions: true })).toEqual([])
    } finally {
      await server.stop()
    }
  })

  test('removal whose response cannot fit fails without writing the tombstone', async () => {
    const { server, backing } = harness({ maxTicketAssetRequestBytes: 2048 })
    try {
      const entries: TicketAssetEntryInput[] = Array.from({ length: 200 }, (_, index) => ({
        type: 'dir' as const,
        path: String(index).padStart(100, 'd'),
      }))
      await backing.putTicketAsset(REPO, 'T-1', {
        kind: 'design',
        name: 'dirs',
        layout: 'tree',
        entries,
      })
      const store = new RemoteBuildStore({ url: server.url })
      await expect(store.removeTicketAsset(REPO, 'T-1', 'design', 'dirs')).rejects.toBeInstanceOf(
        TicketAssetValidationError,
      )
      expect(await backing.listTicketAssets(REPO, 'T-1')).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })
})
