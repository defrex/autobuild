import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTerminalModeController } from '../../core/src/cli/terminal-restore'
import { abDispatch } from '../../core/src/cli/dispatch'
import { spawnExec } from '../../core/src/ports/workspace/git-worktree'
import { RemoteBuildStore, mintToken } from 'autobuild/remote-store'
import {
  CONFIG_TOML,
  happyHandlers,
  makeHarness,
  readyTicket,
  typesOf,
  type E2eHarness,
} from '../../core/src/integration/harness'
import { createHostedStoreService } from './service'

const harnesses: E2eHarness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

test('AB_STORE/AB_TOKEN drive dispatch and every phase through the hosted service', async () => {
  const requests: Array<{ method: string; path: string; authorization: string | null }> = []
  let serviceUrl = ''
  let serviceToken = ''
  const h = await makeHarness({
    handlers: happyHandlers(),
    tickets: [readyTicket('T-1')],
    configToml: CONFIG_TOML.replace('capacity = 2', 'capacity = 2\nforge = "local-git"'),
    localGitForge: true,
    processCli: true,
    storeAdapter: async (backing) => {
      const secret = 'integration-signing-secret'
      const service = createHostedStoreService({
        env: {
          AB_STORE_SECRET: secret,
          AB_POSTGRES_URL: 'postgres://injected/test',
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'injected',
          AB_S3_REGION: 'us-east-1',
          AB_S3_ACCESS_KEY_ID: 'injected',
          AB_S3_SECRET_ACCESS_KEY: 'injected',
        },
        openStore: async () => backing,
      })
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => {
          requests.push({
            method: request.method,
            path: new URL(request.url).pathname,
            authorization: request.headers.get('authorization'),
          })
          return service.fetch(request)
        },
      })
      serviceUrl = `http://127.0.0.1:${server.port}`
      serviceToken = mintToken(secret, {
        build: '*',
        session: '*',
        exp: Date.now() + 60 * 60 * 1000,
      })
      return {
        store: new RemoteBuildStore({ url: serviceUrl, token: serviceToken }),
        storeRef: serviceUrl,
        token: serviceToken,
        cleanup: async () => server.stop(true),
      }
    },
  })
  harnesses.push(h)

  const { store: _store, storeRef: _storeRef, token: _token, ...ports } = h.wiring
  const dispatch = () =>
    abDispatch({
      targetRepo: h.origin,
      env: { AB_STORE: serviceUrl, AB_TOKEN: serviceToken },
      exec: spawnExec,
      stdout: () => {},
      stderr: () => {},
      once: true,
      plain: true,
      nonStoreWire: () => ports,
    })
  await dispatch()

  const events = await h.events('add-rate-limiting')
  expect(h.cliErrors).toEqual([])
  expect(typesOf(events)).toContain('finalize.completed')
  expect(requests.some((entry) => entry.method === 'POST' && entry.path.endsWith('/events'))).toBe(
    true,
  )
  expect(
    requests.some((entry) => entry.method === 'POST' && entry.path.endsWith('/artifacts')),
  ).toBe(true)
  expect(
    requests
      .filter((entry) => entry.path !== '/health')
      .every((entry) => entry.authorization === `Bearer ${serviceToken}`),
  ).toBe(true)
  for (const journal of h.agents.sessions.values()) {
    expect(journal.opts.env.AB_STORE).toBe(serviceUrl)
    expect(journal.opts.env.AB_TOKEN).toBe(serviceToken)
  }
  expect(existsSync(join(h.origin, '.autobuild'))).toBe(false)

  // The terminal-owning parent and its real supervised child both reopen the
  // service from the environment. No work is ready, so a production runtime
  // can safely own this dashboard tick without invoking an external agent.
  await writeFile(
    join(h.origin, 'autobuild.toml'),
    CONFIG_TOML.replace('capacity = 2', 'capacity = 2\nforge = "local-git"').replace(
      'runtime = "scripted"',
      'runtime = "pi"',
    ),
  )
  let dashboardOutput = ''
  const dashboardWrite = (chunk: string): void => {
    dashboardOutput += chunk
  }
  const requestCountBeforeDashboard = requests.length
  await abDispatch({
    targetRepo: h.origin,
    env: { AB_STORE: serviceUrl, AB_TOKEN: serviceToken },
    exec: spawnExec,
    stdout: () => {},
    stderr: () => {},
    once: true,
    terminal: {
      write: dashboardWrite,
      modes: createTerminalModeController(dashboardWrite, dashboardWrite),
      columns: 100,
      rows: 30,
      interactive: true,
    },
    input: { start: () => () => {} },
  })
  const dashboardRequests = requests.slice(requestCountBeforeDashboard)
  expect(dashboardOutput).toContain('add-rate-limiting')
  const repoEvents = await h.store.getRepoEvents(h.origin)
  const dashboardRun = repoEvents.find((event) => event.type === 'dispatcher.run-started')
  expect(dashboardRun?.type).toBe('dispatcher.run-started')
  if (dashboardRun?.type !== 'dispatcher.run-started') throw new Error('missing dashboard run')
  expect(dashboardRun.payload.pid).not.toBe(process.pid)
  expect(repoEvents.some((event) => event.type === 'dispatcher.tick-completed')).toBe(true)
  expect(dashboardRequests.some((entry) => entry.path === '/builds')).toBe(true)
  expect(
    dashboardRequests.some(
      (entry) =>
        entry.method === 'POST' && entry.path.includes('/repos/') && entry.path.endsWith('/events'),
    ),
  ).toBe(true)

  const badToken = mintToken('wrong-secret', {
    build: '*',
    session: '*',
    exp: Date.now() + 60_000,
  })
  await expect(
    abDispatch({
      targetRepo: h.origin,
      env: { AB_STORE: serviceUrl, AB_TOKEN: badToken },
      exec: spawnExec,
      stdout: () => {},
      stderr: () => {},
      once: true,
      terminal: {
        write: () => {},
        modes: createTerminalModeController(
          () => {},
          () => {},
        ),
        columns: 100,
        rows: 30,
        interactive: true,
      },
      input: { start: () => () => {} },
    }),
  ).rejects.toThrow(/invalid or expired token/)
  expect(existsSync(join(h.origin, '.autobuild'))).toBe(false)
}, 20_000)
