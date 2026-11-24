import { expect, test } from 'bun:test'
import { repositoryReadFactsReducer } from '../kernel/read-facts'
import { projectRepositoryFrame } from '../web/repository-source'
import { WebPortInUseError, webServerUrl, type WebServerStarter } from '../web/server'
import { DISPATCH_LAUNCH_CONTEXT_ENV } from './dispatch-launch-contract'
import { SUCCESSOR_BIND_ATTEMPTS, startDispatchWeb } from './dispatch-web'

const successorEnv = {
  [DISPATCH_LAUNCH_CONTEXT_ENV]: JSON.stringify({
    version: 1,
    run: 'successor',
    lineage: 'lineage',
    originalInstall: '/install',
    runtimeRoot: '/runtime',
    checkout: '/checkout',
    predecessor: 'predecessor',
  }),
}

function harness(busyAttempts: number) {
  const calls = { binds: 0, stops: 0, sleeps: 0 }
  const start: WebServerStarter = async (opts) => {
    calls.binds++
    if (calls.binds <= busyAttempts)
      throw new WebPortInUseError(opts.hostname, opts.port, 'ab dispatch')
    return {
      url: webServerUrl(opts.hostname, 4100),
      port: 4100,
      stop: async () => {
        calls.stops++
      },
    }
  }
  const out: string[] = []
  const err: string[] = []
  const base = {
    repo: '/checkout',
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    start,
    sleep: async () => {
      calls.sleeps++
    },
  }
  return { calls, out, err, base }
}

test('a first generation announces once and fails on a taken port', async () => {
  const ok = harness(0)
  const web = await startDispatchWeb({ ...ok.base, options: { port: 0, json: true }, env: {} })
  expect(ok.out).toEqual([JSON.stringify({ url: 'http://127.0.0.1:4100/' })])
  const facts = repositoryReadFactsReducer.finish(repositoryReadFactsReducer.initial())
  const received: string[] = []
  web!.hub.subscribe((json) => received.push(json))
  web!.publishFacts(facts)
  expect(received).toEqual([JSON.stringify(projectRepositoryFrame('/checkout', facts).frame)])
  await Promise.all([web!.close(), web!.close()])
  expect(ok.calls.stops).toBe(1)
  expect(web!.hub.subscribers).toBe(0)

  const widened = harness(0)
  await startDispatchWeb({
    ...widened.base,
    options: { port: 0, host: '0.0.0.0', json: false },
    env: {},
  })
  expect(widened.out).toEqual(['ab dispatch: serving /checkout at http://127.0.0.1:4100/'])
  expect(widened.err.join('\n')).toContain('ab dispatch: --host 0.0.0.0 serves beyond loopback')

  const busy = harness(1)
  await expect(
    startDispatchWeb({ ...busy.base, options: { port: 4100, json: false }, env: {} }),
  ).rejects.toThrow('ab dispatch: port 4100 is already in use')
  expect(busy.calls.sleeps).toBe(0)
})

test('a successor waits for the pinned port, stays silent, and gives up with one warning', async () => {
  const freed = harness(3)
  const web = await startDispatchWeb({
    ...freed.base,
    options: { port: 4100, json: true },
    env: successorEnv,
  })
  expect(web?.url).toBe('http://127.0.0.1:4100/')
  expect(freed.calls.binds).toBe(4)
  expect(freed.out).toEqual([])

  const held = harness(Number.POSITIVE_INFINITY)
  expect(
    await startDispatchWeb({
      ...held.base,
      options: { port: 4100, json: true },
      env: successorEnv,
    }),
  ).toBeUndefined()
  expect(held.calls.binds).toBe(SUCCESSOR_BIND_ATTEMPTS)
  expect(held.err).toHaveLength(1)
  expect(held.err[0]).toStartWith('ab dispatch: web UI unavailable after handoff:')
})
