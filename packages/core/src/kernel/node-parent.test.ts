import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { FakeTicketSource } from '../ports/tickets/fake'
import { DISPATCHER } from '../events/envelope'
import { newestTicketBuild, updateTicketTarget, type ParentContext } from './node-parent'
import { mutateOperatorTicket } from '../operator/tickets'
import { parseConfig } from '../config/load'

async function setup() {
  let time = Date.parse('2026-10-18T00:00:00Z')
  const store = new MemoryBuildStore({
    clock: () => {
      time += 1000
      return new Date(time)
    },
  })
  const source = new FakeTicketSource(
    ['A', 'Q', 'WORK'].map((id) => ({
      revision: 'fixture',
      ref: { source: 'fake', id },
      title: id,
      body: '',
      state: 'Ready',
      resolved: false,
      labels: [],
      kind: id === 'WORK' ? 'work' : 'node',
    })),
  )
  const ctx: ParentContext = {
    store,
    source,
    repo: 'repo',
    root: 'main',
    supportsRetarget: async () => true,
  }
  const build = async (
    id: string,
    slug: string,
    kind: 'node' | 'work' = 'node',
    repo = 'repo',
    ticketSource = 'fake',
  ) => {
    const ticket = { source: ticketSource, id }
    await store.createBuild({
      slug,
      repo,
      ticket,
      branch: `ab-node/${slug}`,
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { repo, ticket, baseBranch: 'main', kind },
      },
    })
    if (kind === 'node')
      await store.append(slug, { actor: DISPATCHER, type: 'node.opened', payload: { sha: 'head' } })
  }
  await build('A', 'a')
  await build('Q', 'q')
  return { ctx, source, store, build }
}

test('latest generation wins, with repository/source isolation and no fallback to an older open node', async () => {
  const { ctx, source, store, build } = await setup()
  await build('Q', 'foreign-repo', 'node', 'elsewhere')
  await build('Q', 'foreign-source', 'node', 'repo', 'other')
  expect((await newestTicketBuild(ctx, (await source.get('Q'))!))!.slug).toBe('q')
  await build('Q', 'new-generation')
  await store.append('new-generation', { actor: DISPATCHER, type: 'build.aborted', payload: {} })
  await expect(updateTicketTarget(ctx, 'A', { target: 'Q', title: 'Changed' })).rejects.toThrow(
    'no longer open',
  )
  expect((await source.get('A'))!.title).toBe('A')
})

test('queued metadata edits and frozen work no-op writes preserve ordinary revision behavior', async () => {
  const { ctx, source, build } = await setup()
  await updateTicketTarget(ctx, 'WORK', { target: 'Q' })
  await build('WORK', 'claimed', 'work')
  // Claim was cut at root, so changing to Q is an actual change even though
  // the provider happened to have Q before the claim fixture was recorded.
  await expect(updateTicketTarget(ctx, 'WORK', { target: 'Q', body: 'Changed' })).rejects.toThrow(
    'abort and re-dispatch',
  )
  await updateTicketTarget(ctx, 'WORK', { target: null, body: 'Root' })
  expect((await source.get('WORK'))!.body).toBe('Root')
})

test('operator mixed updates enforce the shared claimed-work guard', async () => {
  const { store, source, build } = await setup()
  await build('WORK', 'claimed', 'work')
  const config = parseConfig('[tickets]\nsource = "file"\nreadyState = "Ready"\n')
  await expect(
    mutateOperatorTicket({
      store,
      repo: 'repo',
      backend: {
        contextFor: async () => ({
          repo: 'repo',
          tickets: config.tickets,
          baseBranch: 'main',
          teamKey: '',
        }),
        sourceFor: () => source,
        statesFor: () => ['Ready'],
      },
      operation: { kind: 'update', id: 'WORK', patch: { target: 'Q', title: 'Changed' } },
    }),
  ).rejects.toThrow('abort and re-dispatch')
  expect((await source.get('WORK'))!.title).toBe('WORK')
})

test('hosted readable aliases still find historical claims across the database adapter namespace', async () => {
  const { ctx, source, build } = await setup()
  const get = source.get.bind(source)
  source.get = async (id) => {
    const ticket = await get(id === 'old-uuid' ? 'WORK' : id)
    return ticket ? { ...ticket, ref: { ...ticket.ref, source: 'database' } } : null
  }
  Object.defineProperty(source, 'name', { value: 'database' })
  await build('old-uuid', 'old-claim', 'work', 'repo', 'hosted')
  await expect(
    updateTicketTarget({ ...ctx, configuredSource: 'hosted' }, 'WORK', {
      target: 'Q',
      title: 'Changed',
    }),
  ).rejects.toThrow('abort and re-dispatch')
  expect((await source.get('WORK'))!.title).toBe('WORK')
})
