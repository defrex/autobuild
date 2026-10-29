import { requestNodeRestack } from '../operator/restack'
import { Dispatcher } from '../processes/dispatcher'
import { spawnExec } from '../ports/workspace/git-worktree'
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { makeHarness, happyHandlers, readyTicket, git, commitAll, ofType } from './harness'
import { reduceBuild } from '../kernel/reducer'
import { updateTicketTarget } from '../kernel/node-parent'
import { projectTicketTree } from '../ports/tickets/tree'
import { summarize } from '../cli/status'

async function fixture() {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('P', { title: 'Old parent' }), kind: 'node' },
      { ...readyTicket('Q', { title: 'New parent' }), kind: 'node' },
      { ...readyTicket('A', { title: 'Moving node' }), kind: 'node', target: 'P' },
      { ...readyTicket('B', { title: 'Nested child' }), kind: 'node', target: 'A' },
    ],
  })
  const ticks = async (count = 4) => {
    for (let i = 0; i < count; i++) await h.dispatcher.tick()
  }
  await ticks()
  const builds = await h.store.listBuilds()
  const node = (id: string) => builds.find((b) => b.ticket?.id === id)!
  const foreign = async (id: string, file: string, contents = file) => {
    const ws = join(h.tmp, file)
    await git(['worktree', 'add', ws, node(id).branch!], h.origin)
    await Bun.write(join(ws, file), contents)
    const sha = await commitAll(ws, `Foreign ${file}`)
    await git(['worktree', 'remove', ws], h.origin)
    return sha
  }
  const ctx = {
    store: h.store,
    source: h.tickets,
    repo: h.origin,
    root: 'main',
    supportsRetarget: async () => true,
  }
  return { h, ticks, node, foreign, ctx }
}

test('move to another node and root retains own history through nested restacks', async () => {
  const { h, ticks, node, foreign, ctx } = await fixture()
  try {
    const oldParent = await foreign('P', 'parent-only')
    await ticks()
    await foreign('A', 'owned')
    await ticks()
    const a = node('A'),
      b = node('B'),
      q = node('Q')
    const before = reduceBuild(await h.events(a.slug))
    expect(before.pr).toBeDefined()
    await updateTicketTarget(ctx, 'A', { target: 'Q' })
    expect(reduceBuild(await h.events(a.slug)).nodeRestack?.parentRequest).toBeDefined()
    await ticks(6)
    const state = reduceBuild(await h.events(a.slug))
    expect(state.target?.build).toBe(q.slug)
    expect(state.baseBranch).toBe(q.branch)
    expect(state.nodeRestack?.parentChange).toBeUndefined()
    expect(state.pr?.number).toBe(before.pr!.number)
    expect((await h.forgeAdapter.inspectLandingPr!(h.origin, state.pr!.number)).base).toBe(
      q.branch!,
    )
    expect(await git(['show', `${a.branch}:owned`], h.origin)).toBe('owned')
    expect(ofType(await h.events(b.slug), 'node.writer-reserved')).toHaveLength(0)
    await requestNodeRestack({ store: h.store, repo: h.origin, slug: b.slug, user: 'operator' })
    await ticks()
    expect(reduceBuild(await h.events(b.slug)).targetRewrite).toBeUndefined()
    expect(ofType(await h.events(b.slug), 'node.writer-reserved')).toHaveLength(1)
    expect(await git(['rev-list', a.branch!], h.origin)).not.toContain(oldParent)
    expect(await git(['rev-list', b.branch!], h.origin)).not.toContain(oldParent)
    expect(summarize(a, await h.events(a.slug), h.clock()).target).toBe('Q')
    expect(ofType(await h.events(a.slug), 'node.parent-accepted')).toHaveLength(1)
    await ticks()
    expect(ofType(await h.events(a.slug), 'node.parent-accepted')).toHaveLength(1)
    await updateTicketTarget(ctx, 'A', { target: null })
    await ticks(6)
    const root = reduceBuild(await h.events(a.slug))
    expect(root.target).toBeUndefined()
    expect(root.baseBranch).toBe('main')
    expect((await h.forgeAdapter.inspectLandingPr!(h.origin, root.pr!.number)).base).toBe('main')
    const tree = projectTicketTree((await h.tickets.listAll()).tickets, 'main')
    expect(tree.children.find((e) => e.ticket.ref.id === 'A')?.children[0]?.ticket.ref.id).toBe('B')
    expect(
      ofType(await h.events(a.slug), 'node.parent-accepted')[1]?.payload.old.target?.build,
    ).toBe(q.slug)
    expect(h.launched).toHaveLength(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('empty same-head move records parent identity without creating a PR or commits', async () => {
  const { h, ticks, node, ctx } = await fixture()
  try {
    const a = node('A')
    const head = await git(['rev-parse', a.branch!], h.origin)
    await updateTicketTarget(ctx, 'A', { target: 'Q' })
    await ticks()
    const state = reduceBuild(await h.events(a.slug))
    expect(state.target?.build).toBe(node('Q').slug)
    expect(state.nodeRestack?.parentChange).toBeUndefined()
    expect(await git(['rev-parse', a.branch!], h.origin)).toBe(head)
    expect(state.pr).toBeUndefined()
    expect(ofType(await h.events(a.slug), 'node.parent-completed')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('cycles, unopened parents, busy nodes and claimed work refuse combined patches before writing', async () => {
  const { h, ticks, node, ctx } = await fixture()
  try {
    const title = (await h.tickets.get('A'))!.title
    await expect(updateTicketTarget(ctx, 'A', { target: 'B', title: 'Changed' })).rejects.toThrow(
      'cycle',
    )
    expect((await h.tickets.get('A'))!.title).toBe(title)
    await updateTicketTarget(ctx, 'A', { target: 'Q' })
    await expect(updateTicketTarget(ctx, 'A', { target: null, title: 'Changed' })).rejects.toThrow(
      'pending',
    )
    await ticks()
    await h.tickets.create(
      { title: 'Queued', body: readyTicket('WORK').body, target: 'A', labels: ['autobuild'] },
      { state: 'Ready' },
    )
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const work = (await h.store.listBuilds()).find((b) => !b.branch?.startsWith('ab-node/'))!
    expect(work).toBeDefined()
    await expect(
      updateTicketTarget(ctx, work.ticket!.id, { target: 'Q', title: 'Changed' }),
    ).rejects.toThrow('abort and re-dispatch')
    expect((await h.tickets.get(work.ticket!.id))!.title).toBe('Queued')
    expect(reduceBuild(await h.events(node('A').slug)).target?.build).toBe(node('Q').slug)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('publication survives PR acknowledgement failure, later edits wait and retry keeps review identity', async () => {
  const { h, ticks, node, foreign, ctx } = await fixture()
  try {
    await foreign('A', 'owned')
    await ticks()
    const a = node('A')
    const number = reduceBuild(await h.events(a.slug)).pr!.number
    const retarget = h.forgeAdapter.retargetPr!.bind(h.forgeAdapter)
    h.forgeAdapter.retargetPr = async () => {
      throw new Error('transport lost after publication')
    }
    await updateTicketTarget(ctx, 'A', { target: 'Q', title: 'New title' })
    await ticks()
    let state = reduceBuild(await h.events(a.slug))
    expect(state.nodeRestack?.parentReplay).toBe(state.nodeRestack?.parentChange?.id)
    expect(state.nodeRestack?.parentChange).toBeDefined()
    expect(state.integration?.cycle).toBeUndefined()
    expect((await h.forgeAdapter.inspectLandingPr!(h.origin, number)).base).toBe(node('P').branch!)
    await h.tickets.update('A', { target: null })
    await ticks(2)
    expect(ofType(await h.events(a.slug), 'node.parent-accepted')).toHaveLength(1)
    h.forgeAdapter.retargetPr = retarget
    h.dispatcher = new Dispatcher({
      store: h.store,
      tickets: h.tickets,
      workspaces: h.workspaces,
      forge: h.forgeAdapter,
      config: h.config,
      repo: h.origin,
      exec: spawnExec,
      ids: h.ids,
      clock: h.clock,
      launchRunner: async () => {
        throw new Error('clean recovery must not launch an agent')
      },
    })
    await ticks(8)
    state = reduceBuild(await h.events(a.slug))
    expect(state.target).toBeUndefined()
    expect(state.nodeRestack?.parentChange).toBeUndefined()
    expect(state.pr!.number).toBe(number)
    expect((await h.forgeAdapter.inspectLandingPr!(h.origin, number)).base).toBe('main')
    expect((await h.tickets.get('A'))!.title).toBe('New title')
    expect(ofType(await h.events(a.slug), 'node.parent-completed')).toHaveLength(2)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('readback recovers provider success before caller return and cancels an unconfirmed write', async () => {
  const { h, ticks, node, ctx } = await fixture()
  const original = h.tickets.update.bind(h.tickets)
  try {
    h.tickets.update = async (id, patch) => {
      await original(id, patch)
      throw new Error('response lost')
    }
    await expect(updateTicketTarget(ctx, 'A', { target: 'Q' })).rejects.toThrow('response lost')
    h.tickets.update = original
    await ticks()
    expect(reduceBuild(await h.events(node('A').slug)).target?.build).toBe(node('Q').slug)
    h.tickets.update = async () => {
      throw new Error('provider unavailable')
    }
    await expect(updateTicketTarget(ctx, 'A', { target: null })).rejects.toThrow(
      'provider unavailable',
    )
    h.tickets.update = original
    await ticks()
    const state = reduceBuild(await h.events(node('A').slug))
    expect(state.nodeRestack?.parentRequest).toBeUndefined()
    expect(state.target?.build).toBe(node('Q').slug)
    expect(ofType(await h.events(node('A').slug), 'node.parent-cancelled')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('provider-side invalid target is durably deduplicated and preserves effective ancestry', async () => {
  const { h, ticks, node } = await fixture()
  try {
    const get = h.tickets.get.bind(h.tickets)
    h.tickets.get = async (id) => {
      const ticket = await get(id)
      return id === 'A' && ticket
        ? { ...ticket, target: 'MISSING', revision: 'external-revision' }
        : ticket
    }
    await ticks()
    const a = node('A')
    expect(reduceBuild(await h.events(a.slug)).target?.build).toBe(node('P').slug)
    expect(ofType(await h.events(a.slug), 'node.parent-rejected')).toHaveLength(1)
    expect(ofType(await h.events(a.slug), 'node.parent-rejected')[0]!.payload.reason).toContain(
      'does not exist',
    )
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('pending opposite moves cannot activate a cycle and refused patches do not change titles', async () => {
  const { h, ticks, ctx, node } = await fixture()
  try {
    await updateTicketTarget(ctx, 'P', { target: 'Q' })
    await expect(updateTicketTarget(ctx, 'Q', { target: 'P', title: 'Cycle' })).rejects.toThrow(
      'cycle',
    )
    expect((await h.tickets.get('Q'))!.title).toBe('New parent')
    await ticks()
    expect(reduceBuild(await h.events(node('P').slug)).target?.build).toBe(node('Q').slug)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('lifecycle, revision and forge refusals leave mixed ticket patches and node history untouched', async () => {
  const { h, node, ctx } = await fixture()
  try {
    const a = node('A'),
      q = node('Q')
    const revision = (await h.tickets.get('A'))!.revision
    await expect(
      updateTicketTarget(ctx, 'A', { target: 'Q', title: 'Changed' }, 'stale'),
    ).rejects.toThrow('changed')
    await expect(
      updateTicketTarget({ ...ctx, supportsRetarget: async () => false }, 'A', {
        target: 'Q',
        title: 'Changed',
      }),
    ).rejects.toThrow('upgrade the plugin')
    h.tickets.add({
      ...readyTicket('UNOPENED', { title: 'Unopened node' }),
      kind: 'node',
      state: 'Backlog',
    })
    await expect(
      updateTicketTarget(ctx, 'A', { target: 'UNOPENED', title: 'Changed' }),
    ).rejects.toThrow('not yet claimed')
    await h.store.append(q.slug, {
      actor: { kind: 'dispatcher' },
      type: 'build.aborted',
      payload: {},
    })
    await expect(updateTicketTarget(ctx, 'A', { target: 'Q', title: 'Changed' })).rejects.toThrow(
      'no longer open',
    )
    await h.store.append(a.slug, {
      actor: { kind: 'kernel' },
      type: 'integration.landing-intended',
      payload: {
        id: 'landing',
        cycle: 'cycle',
        head: 'head',
        parent: 'parent',
        commandSeq: 1,
        fenced: true,
        evidence: [],
      },
    })
    await expect(updateTicketTarget(ctx, 'A', { target: null, title: 'Changed' })).rejects.toThrow(
      'merging',
    )
    expect((await h.tickets.get('A'))!.revision).toBe(revision)
    expect(ofType(await h.events(a.slug), 'node.parent-requested')).toHaveLength(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('reparent conflict reconciles the source contribution against the frozen new parent', async () => {
  let sourceSlug = ''
  let reconciled = 0
  const h = await makeHarness({
    localGitForge: true,
    handlers: {
      ...happyHandlers(),
      reconcile: async (cli) => {
        await cli.run(['context'])
        const context = await Bun.file(join(cli.ws, cli.env.contextDir!, 'context.json')).json()
        expect(context.nodeChange).toMatchObject({ build: sourceSlug, foreign: false })
        expect(await Bun.file(join(cli.ws, cli.env.contextDir!, 'plan.md')).text()).toContain(
          'Add rate-limit.txt',
        )
        await Bun.write(join(cli.ws, 'rate-limit.txt'), 'preserve both lines\n')
        await git(['add', 'rate-limit.txt'], cli.ws)
        await git(['-c', 'core.editor=true', 'cherry-pick', '--continue'], cli.ws)
        await Bun.write(
          join(cli.ws, '.ab/reconcile-notes.md'),
          'Resolved against the new parent.\n',
        )
        await cli.run(['done', '--notes', join(cli.ws, '.ab/reconcile-notes.md')])
        reconciled++
      },
    },
    tickets: [
      { ...readyTicket('P', { title: 'Old line' }), kind: 'node' },
      { ...readyTicket('Q', { title: 'New line' }), kind: 'node' },
      { ...readyTicket('A', { title: 'Moving line' }), kind: 'node', target: 'P' },
      { ...readyTicket('CHILD', { title: 'Source contribution' }), target: 'A' },
      { ...readyTicket('OPEN', { title: 'Keep collecting' }), state: 'Backlog', target: 'A' },
    ],
  })
  const ticks = async (n = 4) => {
    for (let i = 0; i < n; i++) await h.dispatcher.tick()
  }
  try {
    await ticks()
    const records = await h.store.listBuilds()
    const a = records.find((b) => b.ticket?.id === 'A')!
    const q = records.find((b) => b.ticket?.id === 'Q')!
    const child = records.find((b) => b.ticket?.id === 'CHILD')!
    sourceSlug = child.slug
    await h.runLatest()
    const source = reduceBuild(await h.events(child.slug))
    await h.forgeAdapter.squashMerge(h.origin, source.pr!.number, source.pr!.headSha, {
      buildSlug: child.slug,
    })
    await ticks()
    const ws = join(h.tmp, 'new-line')
    await git(['worktree', 'add', ws, q.branch!], h.origin)
    await Bun.write(join(ws, 'rate-limit.txt'), 'New line behavior\n')
    await commitAll(ws, 'Conflicting new parent')
    await git(['worktree', 'remove', ws], h.origin)
    await updateTicketTarget(
      {
        store: h.store,
        source: h.tickets,
        repo: h.origin,
        root: 'main',
        supportsRetarget: async () => true,
      },
      'A',
      { target: 'Q' },
    )
    await ticks(2)
    const conflict = reduceBuild(await h.events(a.slug))
    expect(conflict.nodeRestack?.conflict).toBeDefined()
    expect(conflict.target?.build).toBe(q.slug)
    expect(conflict.nodeRestack?.active?.parent).toBe(await git(['rev-parse', q.branch!], h.origin))
    await h.runLatest()
    h.clock.advance(120_000)
    await ticks(6)
    expect(reconciled).toBe(1)
    expect(reduceBuild(await h.events(a.slug)).nodeRestack?.parentChange).toBeUndefined()
    expect(await git(['show', `${a.branch}:rate-limit.txt`], h.origin)).toBe('preserve both lines')
    expect(reduceBuild(await h.events(a.slug)).nodeRestack?.inventory?.builds).toContain(sourceSlug)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a pending departure does not hide a destination effective ancestor cycle', async () => {
  const { h, ctx } = await fixture()
  try {
    await updateTicketTarget(ctx, 'B', { target: null })
    // Provider metadata now permits this, but B is still effectively under A.
    await expect(updateTicketTarget(ctx, 'A', { target: 'B' })).rejects.toThrow(
      'effective or pending cycle',
    )
    expect((await h.tickets.get('A'))!.target).toBe('P')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('pending intent survives writer contention and lease expiry before activation', async () => {
  const { h, ctx, node, ticks } = await fixture()
  try {
    const a = node('A')
    expect(await h.store.claimNodeWriter(a.slug, 'other-writer', 60_000)).toBe(true)
    await expect(updateTicketTarget(ctx, 'A', { target: 'Q', title: 'Changed' })).rejects.toThrow(
      'writer is busy',
    )
    expect((await h.tickets.get('A'))!.title).toBe('Moving node')
    await h.store.releaseNodeWriter(a.slug, 'other-writer')
    await updateTicketTarget(ctx, 'A', { target: 'Q' })
    expect(await h.store.claimNodeWriter(a.slug, 'crashed-holder', 60_000)).toBe(true)
    await ticks(1)
    expect(reduceBuild(await h.events(a.slug)).nodeRestack?.parentRequest).toBeDefined()
    h.clock.advance(61_000)
    await ticks()
    expect(reduceBuild(await h.events(a.slug)).target?.build).toBe(node('Q').slug)
    expect(reduceBuild(await h.events(a.slug)).nodeRestack?.parentChange).toBeUndefined()
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('reparent retries head-CAS contention and retains a concurrent node-owned change', async () => {
  const { h, ctx, node, ticks, foreign } = await fixture()
  const rewrite = h.forgeAdapter.rewrite!
  Object.defineProperty(h.forgeAdapter, 'rewrite', { configurable: true, value: rewrite })
  const replace = rewrite.replace.bind(rewrite)
  let contended = false
  try {
    await foreign('A', 'owned')
    await ticks()
    const a = node('A')
    rewrite.replace = async (input) => {
      if (input.branch === a.branch && !contended) {
        contended = true
        await foreign('A', 'concurrent-owned')
      }
      return replace(input)
    }
    await updateTicketTarget(ctx, 'A', { target: 'Q' })
    await ticks(8)
    expect(contended).toBe(true)
    expect(
      ofType(await h.events(a.slug), 'node.writer-settled').some(
        (e) => e.payload.outcome === 'contended',
      ),
    ).toBe(true)
    expect(reduceBuild(await h.events(a.slug)).nodeRestack?.parentChange).toBeUndefined()
    expect(await git(['show', `${a.branch}:owned`], h.origin)).toBe('owned')
    expect(await git(['show', `${a.branch}:concurrent-owned`], h.origin)).toBe('concurrent-owned')
    expect(ofType(await h.events(a.slug), 'node.parent-accepted')).toHaveLength(1)
  } finally {
    rewrite.replace = replace
    Reflect.deleteProperty(h.forgeAdapter, 'rewrite')
    await h.cleanup()
  }
}, 30_000)

for (const mode of ['missing', 'throwing'] as const)
  test(`tracker ${mode} reads withhold a move while safe nested restacks continue`, async () => {
    const { h, node, foreign, ticks } = await fixture()
    try {
      const a = node('A'),
        b = node('B')
      await foreign('A', 'owned-during-outage')
      await ticks()
      const get = h.tickets.get.bind(h.tickets)
      h.tickets.get = async (id) => {
        if (id === 'A' || id === 'B') {
          if (mode === 'throwing') throw new Error('tracker rate limited')
          return null
        }
        return get(id)
      }
      // Advance the effective parent independently of the unreadable metadata.
      const parent = await foreign('P', 'upstream-during-outage')
      const report = await h.dispatcher.tick()
      expect(report.janitorFailed).toBe(0)
      expect(report.janitorDiagnostics.join(' ')).toContain('ticket target observation failed')
      for (const record of [a, b]) {
        await requestNodeRestack({
          store: h.store,
          repo: h.origin,
          slug: record.slug,
          user: 'operator',
        })
        await ticks()
      }
      expect(await git(['merge-base', '--is-ancestor', parent, a.branch!], h.origin)).toBe('')
      expect(await git(['show', `${a.branch}:owned-during-outage`], h.origin)).toBe(
        'owned-during-outage',
      )
      expect(reduceBuild(await h.events(b.slug)).targetRewrite).toBeUndefined()
      expect(ofType(await h.events(b.slug), 'node.writer-reserved')).toHaveLength(1)
      expect(await git(['merge-base', '--is-ancestor', parent, b.branch!], h.origin)).toBe('')
      expect(reduceBuild(await h.events(a.slug)).target?.build).toBe(node('P').slug)
      expect(ofType(await h.events(a.slug), 'node.parent-accepted')).toHaveLength(0)
    } finally {
      await h.cleanup()
    }
  }, 30_000)

test('tracker transport errors do not suppress work PR merge observation', async () => {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [readyTicket('WORK')],
  })
  try {
    await h.dispatcher.tick()
    await h.runLatest()
    const work = (await h.store.listBuilds())[0]!
    const state = reduceBuild(await h.events(work.slug))
    await h.forgeAdapter.squashMerge(h.origin, state.pr!.number, state.pr!.headSha)
    h.tickets.get = async () => {
      throw new Error('tracker rate limited')
    }
    const report = await h.dispatcher.tick()
    expect(report.janitorDiagnostics.join(' ')).toContain('tracker rate limited')
    expect(ofType(await h.events(work.slug), 'pr.merged')).toHaveLength(1)
    expect(reduceBuild(await h.events(work.slug)).status).toBe('done')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('correcting provider metadata clears node and work rejections durably without reparenting', async () => {
  const { h, node, ticks } = await fixture()
  try {
    const get = h.tickets.get.bind(h.tickets)
    h.tickets.get = async (id) => {
      const ticket = await get(id)
      return id === 'A' && ticket ? { ...ticket, target: 'MISSING', revision: 'bad-edit' } : ticket
    }
    await ticks(2)
    const a = node('A')
    expect(reduceBuild(await h.events(a.slug)).nodeRestack?.parentRejection).toBeDefined()
    h.tickets.get = get
    await ticks()
    expect(reduceBuild(await h.events(a.slug)).nodeRestack?.parentRejection).toBeUndefined()
    expect(ofType(await h.events(a.slug), 'node.parent-rejection-cleared')).toHaveLength(1)
    expect(ofType(await h.events(a.slug), 'node.parent-accepted')).toHaveLength(0)
    // A claimed work build has the same diagnostic lifecycle, while its target
    // remains frozen throughout.
    h.tickets.add({ ...readyTicket('WORK'), target: 'A' })
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const work = (await h.store.listBuilds()).find((b) => b.ticket?.id === 'WORK')!
    await h.tickets.update('WORK', { target: 'Q' })
    await ticks(2)
    expect(reduceBuild(await h.events(work.slug)).nodeRestack?.parentRejection).toBeDefined()
    await h.tickets.update('WORK', { target: 'A' })
    await ticks()
    expect(reduceBuild(await h.events(work.slug)).nodeRestack?.parentRejection).toBeUndefined()
    expect(reduceBuild(await h.events(work.slug)).target?.build).toBe(a.slug)
    expect(ofType(await h.events(work.slug), 'node.parent-rejected')).toHaveLength(1)
    expect(ofType(await h.events(work.slug), 'node.parent-rejection-cleared')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an accepted move finishes its PR effects while the tracker is unavailable', async () => {
  const { h, node, foreign, ticks, ctx } = await fixture()
  try {
    await foreign('A', 'owned')
    await ticks()
    const a = node('A')
    const retarget = h.forgeAdapter.retargetPr!.bind(h.forgeAdapter)
    h.forgeAdapter.retargetPr = async () => {
      throw new Error('forge temporarily unavailable')
    }
    await updateTicketTarget(ctx, 'A', { target: 'Q' })
    await ticks(2)
    const pending = reduceBuild(await h.events(a.slug))
    expect(pending.nodeRestack?.parentChange).toBeDefined()
    expect(pending.nodeRestack?.parentReplay).toBe(pending.nodeRestack?.parentChange?.id)
    h.forgeAdapter.retargetPr = retarget
    h.tickets.get = async () => {
      throw new Error('tracker unavailable')
    }
    await ticks(2)
    const completed = reduceBuild(await h.events(a.slug))
    expect(completed.nodeRestack?.parentChange).toBeUndefined()
    expect((await h.forgeAdapter.inspectLandingPr!(h.origin, completed.pr!.number)).base).toBe(
      node('Q').branch!,
    )
    expect(ofType(await h.events(a.slug), 'node.parent-completed')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)
