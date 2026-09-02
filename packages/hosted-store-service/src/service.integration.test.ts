import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTerminalModeController } from '../../core/src/cli/terminal-restore'
import { abDispatch } from '../../core/src/cli/dispatch'
import { agentActor, KERNEL } from '../../core/src/events/envelope'
import { createTicketSource } from '../../core/src/ports/tickets/create'
import { FakeTicketSource } from '../../core/src/ports/tickets/fake'
import type { TicketSource } from '../../core/src/ports/types'
import { spawnExec } from '../../core/src/ports/workspace/git-worktree'
import { OperatorApiClient } from 'autobuild/operator-api'
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
  const serviceSecret = 'integration-signing-secret'
  let hostedTickets: TicketSource | undefined
  const ticketBackend = new FakeTicketSource([
    { ...readyTicket('T-1'), blockedBy: ['T-blocker'] },
    readyTicket('T-blocker', { state: 'Triage', title: 'Dependency' }),
  ])
  const hostedConfig = CONFIG_TOML.replace(
    'source = "file"',
    'source = "hosted"\nteamKey = "ENG"',
  ).replace('capacity = 2', 'capacity = 2\nforge = "local-git"')
  const h = await makeHarness({
    handlers: happyHandlers(),
    ticketSource: ticketBackend,
    configToml: hostedConfig,
    localGitForge: true,
    processCli: true,
    storeAdapter: async (backing) => {
      const service = createHostedStoreService({
        env: {
          AB_STORE_SECRET: serviceSecret,
          AB_POSTGRES_URL: 'postgres://injected/test',
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'injected',
          AB_S3_REGION: 'us-east-1',
          AB_S3_ACCESS_KEY_ID: 'injected',
          AB_S3_SECRET_ACCESS_KEY: 'injected',
        },
        openStore: async () => backing,
        sourceFor: () => ticketBackend,
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
      serviceToken = mintToken(serviceSecret, {
        operator: true,
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

  const {
    store: _store,
    storeRef: _storeRef,
    token: _token,
    tickets: _tickets,
    ...ports
  } = h.wiring
  const dispatch = () =>
    abDispatch({
      targetRepo: h.origin,
      env: { AB_STORE: serviceUrl, AB_TOKEN: serviceToken },
      exec: spawnExec,
      stdout: () => {},
      stderr: () => {},
      once: true,
      plain: true,
      nonStoreWire: async (config, opts, state, plugins) => {
        hostedTickets = await createTicketSource(
          config.tickets,
          opts.env,
          state.repo,
          state.localStateRoot,
          plugins,
        )
        return { ...ports, tickets: hostedTickets }
      },
    })

  // The first real dispatch tick reaches the hosted source, closes the
  // dependency graph, and leaves the blocked ticket unclaimed.
  await dispatch()
  expect(ticketBackend.claims).not.toContain('T-1')
  expect(requests.some((entry) => entry.path === '/tickets/dependency-states')).toBe(true)

  // Completing the dependency through HTTP makes the next tick claim,
  // comment on, and ultimately complete the target through the same service.
  if (hostedTickets === undefined) throw new Error('hosted ticket source was not constructed')
  await hostedTickets.transition('T-blocker', 'Done')
  await dispatch()
  const events = await h.events('add-rate-limiting')
  expect(h.cliErrors).toEqual([])
  expect(typesOf(events)).toContain('finalize.completed')
  expect(ticketBackend.claims).toContain('T-1')
  expect(ticketBackend.comments).toEqual([
    { id: 'T-1', body: 'build add-rate-limiting dispatched' },
  ])
  // A second ready ticket with an invalid spec exercises the dispatcher's
  // hosted comment + handback transition path without launching another build.
  ticketBackend.add(readyTicket('T-handback', { body: 'not a conforming spec' }))
  await dispatch()
  expect(ticketBackend.comments.some((comment) => comment.id === 'T-handback')).toBe(true)
  expect(ticketBackend.transitions).toContainEqual({ id: 'T-handback', state: 'Triage' })
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
    hostedConfig.replace('runtime = "scripted"', 'runtime = "pi"'),
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

  // Exercise the operator surface through the actual Bun listener, not only
  // the host-neutral in-process Fetch composition.
  const operatorToken = mintToken(serviceSecret, {
    operator: { user: 'HTTP Operator' },
    exp: Date.now() + 60_000,
  })
  const operator = new OperatorApiClient({ url: serviceUrl, token: operatorToken })
  const operatorDashboard = await operator.dashboard(h.origin)
  expect(operatorDashboard.model.repo).toBe(h.origin)
  expect(operatorDashboard.model.builds.some((build) => build.slug === 'add-rate-limiting')).toBe(
    true,
  )
  expect(await operator.repositoryStatus(h.origin)).toMatchObject({ repo: h.origin })
  expect(await operator.harvestStatus(h.origin)).toMatchObject({ repo: h.origin })
  await operator.setIntake(h.origin, false)
  expect((await h.store.getRepoEvents(h.origin)).at(-1)).toMatchObject({
    actor: { kind: 'human', user: 'HTTP Operator' },
    type: 'dispatcher.intake-set',
    payload: { enabled: false },
  })

  const answerSlug = 'operator-answer'
  await h.store.createBuild({
    slug: answerSlug,
    repo: h.origin,
    ticket: { source: 'fake', id: 'T-operator' },
  })
  await h.store.append(answerSlug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'operator-runner', host: 'integration-host' },
  })
  const oldSpec = await h.store.putArtifact(answerSlug, { kind: 'spec', content: 'old spec' })
  await h.store.append(answerSlug, {
    actor: agentActor('spec', 'operator-spec-session'),
    type: 'spec.authored',
    payload: {
      artifact: { kind: oldSpec.kind, rev: oldSpec.revision },
      session: 'operator-spec-session',
    },
  })
  await h.store.append(answerSlug, {
    actor: agentActor('implement', 'operator-implement-session'),
    type: 'escalation.raised',
    payload: {
      id: 'operator-escalation',
      phase: 'implement',
      round: 1,
      source: 'agent',
      question: 'Replace the spec?',
    },
  })
  const replacement = [
    '# Replacement',
    '',
    '## Acceptance criteria',
    '- The listener path revises this build.',
    '',
    '## Out of scope',
    '- Nothing else.',
    '',
  ].join('\n')
  await operator.answer(h.origin, answerSlug, {
    resolution: 'revise-spec',
    origin: 'body',
    body: replacement,
  })
  const revised = await operator.downloadArtifact(h.origin, answerSlug, 'spec', 1)
  expect(new TextDecoder().decode(revised.content)).toBe(replacement)
  expect((await h.store.getEvents(answerSlug)).filter((event) => event.seq > 3)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor: { kind: 'human', user: 'HTTP Operator' },
        type: 'escalation.answered',
      }),
      expect.objectContaining({ type: 'spec.revised' }),
    ]),
  )

  const rejectedScopes = [
    serviceToken,
    mintToken(serviceSecret, {
      build: answerSlug,
      session: '*',
      exp: Date.now() + 60_000,
    }),
    mintToken(serviceSecret, {
      resource: { kind: 'repo', id: h.origin },
      session: '*',
      exp: Date.now() + 60_000,
    }),
  ]
  for (const token of rejectedScopes) {
    const error = await new OperatorApiClient({ url: serviceUrl, token })
      .repositoryStatus(h.origin)
      .catch((caught) => caught)
    expect(error).toMatchObject({ status: 403, kind: 'auth' })
  }

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
