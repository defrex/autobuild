import { expect, test } from 'bun:test'
import {
  selectDispatchMode,
  DispatchPlacementStartupError,
  type DispatchModeOptions,
} from './dispatch-mode'
import { resolveRepoStatePaths } from './repo-state'
import { RemoteBuildStore } from '../store/remote/client'
import type { DispatchPlacement } from '../kernel/dispatch-placement'
import { parseDispatchArgs } from './dispatch-args'

const options: DispatchModeOptions = {
  targetRepo: '/checkout',
  env: { AB_TOKEN: 'secret-token' },
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  stderr: () => {},
}
const state = resolveRepoStatePaths({
  repo: 'https://github.com/acme/repo',
  checkout: '/checkout',
  storeRef: 'https://store.test',
})

test('takeover arguments conflict with viewer and preserve other flags', () => {
  expect(parseDispatchArgs(['--takeover', '--once'], {}).takeover).toBe(true)
  expect(() => parseDispatchArgs(['--viewer', '--takeover'], {})).toThrow('cannot be combined')
})
for (const placement of [
  { status: 'known', placement: { hosted: true, origin: 'https://hosted.test:8443' } },
  { status: 'known', placement: { hosted: false } },
  { status: 'unknown', reason: 'unrecorded' },
  { status: 'unknown', reason: 'unsupported-capability' },
] satisfies DispatchPlacement[]) {
  test(`selection from ${JSON.stringify(placement)} reads once and closes`, async () => {
    let reads = 0
    let closed = 0
    const result = await selectDispatchMode(options, {
      resolve: async () => state,
      open: (url, token) => {
        expect(url).toBe(state.storeRef)
        expect(token).toBe('secret-token')
        return {
          getDispatchPlacement: async (repo) => {
            expect(repo).toBe(state.repo)
            reads++
            return placement
          },
          close: async () => {
            closed++
          },
        }
      },
    })
    expect(reads).toBe(1)
    expect(closed).toBe(1)
    expect(result).toEqual(
      placement.status === 'known' && placement.placement.hosted
        ? { viewer: true, dispatchedBy: 'hosted.test:8443' }
        : { viewer: false },
    )
  })
}
test('explicit modes and origin bypass resolution; takeover warns once', async () => {
  const warnings: string[] = []
  for (const mode of [
    { viewer: true },
    { takeover: true },
    { repository: 'https://github.com/a/b' },
    { env: { AB_REPOSITORY: 'https://github.com/a/b' } },
  ]) {
    await selectDispatchMode(
      { ...options, ...mode, stderr: (line) => warnings.push(line) },
      {
        resolve: async () => {
          throw new Error('must not resolve')
        },
      },
    )
  }
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('displace')
})
test('local stores never open a remote reader', async () => {
  expect(
    await selectDispatchMode(options, {
      resolve: async () => ({ ...state, storeRef: '/local' }),
      open: () => {
        throw new Error('must not open')
      },
    }),
  ).toEqual({ viewer: false })
})
for (const detail of [
  'HTTP 401 authentication',
  'unsupported protocol',
  'malformed capability',
  'unreachable service',
]) {
  test(`fails closed for ${detail}, closes reader, retains cause and redacts token`, async () => {
    const cause = new Error(`${detail}: secret-token`)
    let closed = false
    try {
      await selectDispatchMode(options, {
        resolve: async () => state,
        open: () => ({
          getDispatchPlacement: async () => {
            throw cause
          },
          close: async () => {
            closed = true
          },
        }),
      })
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(DispatchPlacementStartupError)
      const typed = error as DispatchPlacementStartupError
      expect(typed.code).toBe('DISPATCH_PLACEMENT_UNREADABLE')
      expect(typed.cause).toBe(cause)
      expect(typed.message).toContain(detail)
      expect(typed.message).toContain('--viewer')
      expect(typed.message).toContain('--takeover')
      expect(typed.message).not.toContain('secret-token')
    }
    expect(closed).toBe(true)
  })
}
test('hosted automatic viewer rejects startup intake', async () => {
  await expect(
    selectDispatchMode(
      { ...options, intake: false },
      {
        resolve: async () => state,
        open: () => ({
          getDispatchPlacement: async () => ({
            status: 'known',
            placement: { hosted: true, origin: 'https://hosted.test' },
          }),
          close: async () => {},
        }),
      },
    ),
  ).rejects.toThrow('--takeover')
})
for (const scenario of ['hosted', 'legacy', 'failed', 'malformed'] as const) {
  test(`real remote client negotiation: ${scenario}`, async () => {
    const paths: string[] = []
    const fetchFn = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/health')
        return Response.json(
          scenario === 'malformed'
            ? { capabilities: 42 }
            : { capabilities: scenario === 'legacy' ? [] : ['dispatch-placement-v1'] },
        )
      if (scenario === 'failed') return new Response('unavailable', { status: 503 })
      return Response.json({
        status: 'known',
        placement: { hosted: true, origin: 'https://hosted.test' },
      })
    }) as typeof fetch
    const selection = selectDispatchMode(options, {
      resolve: async () => state,
      open: (url, token) => new RemoteBuildStore({ url, token, fetchFn }),
    })
    if (scenario === 'failed' || scenario === 'malformed')
      await expect(selection).rejects.toBeInstanceOf(DispatchPlacementStartupError)
    else expect((await selection).viewer).toBe(scenario === 'hosted')
    expect(paths.filter((path) => path === '/health')).toHaveLength(1)
    expect(paths.filter((path) => path.endsWith('/placement'))).toHaveLength(
      scenario === 'legacy' || scenario === 'malformed' ? 0 : 1,
    )
  })
}

for (const status of [401, 403, 404, 426])
  test(`advertised placement HTTP ${status} fails closed`, async () => {
    await expect(
      selectDispatchMode(options, {
        resolve: async () => state,
        open: (url, token) =>
          new RemoteBuildStore({
            url,
            token,
            fetchFn: (async (input) => {
              if (String(input).endsWith('/health'))
                return Response.json({ capabilities: ['dispatch-placement-v1'] })
              return Response.json({ error: `placement HTTP ${status}`, kind: 'error' }, { status })
            }) as typeof fetch,
          }),
      }),
    ).rejects.toBeInstanceOf(DispatchPlacementStartupError)
  })

test('repository resolution failures fail closed without opening a store', async () => {
  await expect(
    selectDispatchMode(options, {
      resolve: async () => {
        throw new Error('invalid repository store configuration')
      },
      open: () => {
        throw new Error('must not open')
      },
    }),
  ).rejects.toThrow('invalid repository store configuration')
})

test('advertised malformed placement payload fails closed', async () => {
  await expect(
    selectDispatchMode(options, {
      resolve: async () => state,
      open: (url, token) =>
        new RemoteBuildStore({
          url,
          token,
          fetchFn: (async (input) =>
            Response.json(
              String(input).endsWith('/health')
                ? { capabilities: ['dispatch-placement-v1'] }
                : {
                    status: 'known',
                    placement: { hosted: true, origin: 'https://user:password@host.test' },
                  },
            )) as typeof fetch,
        }),
    }),
  ).rejects.toBeInstanceOf(DispatchPlacementStartupError)
})
