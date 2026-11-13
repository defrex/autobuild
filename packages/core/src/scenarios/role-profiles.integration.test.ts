/**
 * Label-selected role profiles end to end (SPEC §9): a ticket labelled with a
 * profile's label builds every session through the profile's overlay of the
 * repository roles, an unlabelled ticket builds on the repository roles, and
 * a profile's contents are read from the current dispatcher configuration at
 * each session boundary — an edit reaches only the builds that selected it,
 * and a removal falls back to the repository roles with status saying so.
 * In-memory store, scripted agents, fake forge; no network.
 */
import { afterEach, expect, test } from 'bun:test'
import { detail, renderDetail } from '../cli/status'
import { parseConfig } from '../config/load'
import type { Config } from '../config/schema'
import { reduceBuild } from '../kernel/reducer'
import {
  CONFIG_TOML,
  happyHandlers,
  makeHarness,
  ofType,
  readyTicket,
  type E2eHarness,
} from './harness'

const PROFILE_TOML = `${CONFIG_TOML}
[profiles.deep]
label = "deep"

[profiles.deep.roles.plan-review]
runtime = "pi"
model = "kimi-k3"

[profiles.deep.roles.implement]
args = ["--effort", "high"]
`

const harnesses: E2eHarness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

async function slugFor(h: E2eHarness, ticket: string): Promise<string> {
  for (const record of await h.store.listBuilds())
    if (record.ticket?.id === ticket) return record.slug
  throw new Error(`no build for ticket ${ticket}`)
}

async function runBuild(h: E2eHarness, slug: string) {
  const launched = h.launched.find((entry) => entry.slug === slug)!
  return launched.runner.run()
}

test('a labelled build routes through its profile; an unlabelled one uses the repository roles', async () => {
  const h = await makeHarness({
    handlers: happyHandlers(),
    tickets: [
      readyTicket('T-deep', { labels: ['autobuild', 'deep'] }),
      readyTicket('T-plain', { title: 'Add audit logging' }),
    ],
    configToml: PROFILE_TOML,
  })
  harnesses.push(h)

  expect((await h.dispatcher.tick()).dispatched).toBe(2)
  const deep = await slugFor(h, 'T-deep')
  const plain = await slugFor(h, 'T-plain')

  expect((await runBuild(h, deep)).prState).toBe('open')
  expect(h.cliErrors).toEqual([])
  const started = ofType(await h.events(deep), 'session.started')
  const role = (name: string) => started.find((event) => event.payload.role === name)!.payload
  expect(role('plan-review')).toMatchObject({ runner: 'pi', model: 'kimi-k3', args: [] })
  expect(role('implement')).toMatchObject({ runner: 'scripted', args: ['--effort', 'high'] })
  expect(role('implement').model).toBeUndefined()
  for (const name of ['plan', 'code-review', 'finalize'])
    expect(role(name)).toMatchObject({ runner: 'scripted', args: [] })
  for (const event of started)
    expect(event.payload.profile).toEqual({ name: 'deep', configured: true })

  expect((await runBuild(h, plain)).prState).toBe('open')
  expect(h.cliErrors).toEqual([])
  const plainStarted = ofType(await h.events(plain), 'session.started')
  for (const event of plainStarted) {
    expect(event.payload).toMatchObject({ runner: 'scripted', args: [] })
    expect(event.payload).not.toHaveProperty('profile')
  }
  expect(reduceBuild(await h.events(plain))).not.toHaveProperty('profile')
}, 60_000)

test('an edited profile reaches only the builds that selected it, at their next session', async () => {
  let current: Config = parseConfig(PROFILE_TOML, 'e2e autobuild.toml')
  const edited = parseConfig(
    PROFILE_TOML.replace('model = "kimi-k3"', 'model = "kimi-k4"'),
    'e2e autobuild.toml',
  )
  const handlers = happyHandlers()
  const plan = handlers.plan!
  handlers.plan = async (cli) => {
    await plan(cli)
    current = edited
  }
  const h = await makeHarness({
    handlers,
    tickets: [
      readyTicket('T-deep', { labels: ['autobuild', 'deep'] }),
      readyTicket('T-plain', { title: 'Add audit logging' }),
    ],
    configToml: PROFILE_TOML,
    pinnedConfig: true,
    getConfig: () => current,
  })
  harnesses.push(h)

  expect((await h.dispatcher.tick()).dispatched).toBe(2)
  const deep = await slugFor(h, 'T-deep')
  const plain = await slugFor(h, 'T-plain')
  expect((await runBuild(h, deep)).prState).toBe('open')
  expect((await runBuild(h, plain)).prState).toBe('open')
  expect(h.cliErrors).toEqual([])

  const deepReview = ofType(await h.events(deep), 'session.started').find(
    (event) => event.payload.role === 'plan-review',
  )!
  expect(deepReview.payload).toMatchObject({ runner: 'pi', model: 'kimi-k4' })
  const plainReview = ofType(await h.events(plain), 'session.started').find(
    (event) => event.payload.role === 'plan-review',
  )!
  expect(plainReview.payload).toMatchObject({ runner: 'scripted', args: [] })
  expect(plainReview.payload.model).toBeUndefined()
}, 60_000)

test('a removed profile falls back to the repository roles and status says so', async () => {
  let current: Config = parseConfig(PROFILE_TOML, 'e2e autobuild.toml')
  const removed = parseConfig(CONFIG_TOML, 'e2e autobuild.toml')
  const handlers = happyHandlers()
  const plan = handlers.plan!
  handlers.plan = async (cli) => {
    await plan(cli)
    current = removed
  }
  const h = await makeHarness({
    handlers,
    tickets: [readyTicket('T-deep', { labels: ['autobuild', 'deep'] })],
    configToml: PROFILE_TOML,
    pinnedConfig: true,
    getConfig: () => current,
  })
  harnesses.push(h)

  expect((await h.dispatcher.tick()).dispatched).toBe(1)
  const deep = await slugFor(h, 'T-deep')
  expect((await runBuild(h, deep)).prState).toBe('open')
  expect(h.cliErrors).toEqual([])

  const events = await h.events(deep)
  const started = ofType(events, 'session.started')
  expect(started.find((event) => event.payload.role === 'plan')!.payload.profile).toEqual({
    name: 'deep',
    configured: true,
  })
  const review = started.find((event) => event.payload.role === 'plan-review')!.payload
  expect(review).toMatchObject({
    runner: 'scripted',
    args: [],
    profile: { name: 'deep', configured: false },
  })
  expect(review.model).toBeUndefined()

  const record = (await h.store.listBuilds()).find((entry) => entry.slug === deep)!
  const now = new Date()
  const shown = detail(record, events, now)
  expect(shown.profile).toEqual({ name: 'deep', configured: false })
  expect(renderDetail(shown, now)).toContain(
    "  profile:  deep (no longer configured — sessions use the repository's roles)",
  )
}, 60_000)
