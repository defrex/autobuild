import { projectBuild } from '../cli/dashboard/model'
import { buildActionAvailability } from '../cli/dashboard/actions'
import { summarize } from '../cli/status'
import { expect, test } from 'bun:test'
import { makeHarness, happyHandlers, readyTicket, CONFIG_TOML, ofType } from './harness'
import { reduceBuild } from '../kernel/reducer'
import { controlBuild } from '../cli/build-control'

test('real git node claims, child landing, lazy PR and human node landing', async () => {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('NODE', { title: 'Integration node' }), kind: 'node' },
      { ...readyTicket('CHILD', { title: 'Child change' }), target: 'NODE' },
    ],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'NODE')!
    expect(node.branch).toStartWith('ab-node/')
    expect(h.launched).toHaveLength(0)
    const emptyEvents = await h.events(node.slug)
    const row = projectBuild(node, reduceBuild(emptyEvents), h.config, emptyEvents)!
    expect(row).toMatchObject({ kind: 'integration', target: 'main', integration: 'empty' })
    expect(row.steps.some((s) => s.label === 'implement')).toBe(false)
    expect(buildActionAvailability(row)).toMatchObject({
      abort: true,
      autoMerge: false,
      discard: false,
    })
    expect(summarize(node, emptyEvents, h.clock())).toMatchObject({
      kind: 'integration',
      target: 'main',
      integration: 'empty',
      status: 'collecting',
    })
    expect(reduceBuild(await h.events(node.slug)).status).toBe('collecting')
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const child = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'CHILD')!
    expect(ofType(await h.events(child.slug), 'build.created')[0]?.payload.baseBranch).toBe(
      node.branch!,
    )
    await h.runLatest()
    const childState = reduceBuild(await h.events(child.slug))
    expect(childState.pr).toBeDefined()
    await h.forgeAdapter.squashMerge(h.origin, childState.pr!.number, childState.pr!.headSha)
    await h.dispatcher.tick()
    await h.dispatcher.tick()
    const nodeState = reduceBuild(await h.events(node.slug))
    expect(nodeState.pr).toBeDefined()
    expect(h.launched.every((r) => r.slug !== node.slug)).toBe(true)
    await h.forgeAdapter.squashMerge(h.origin, nodeState.pr!.number, nodeState.pr!.headSha)
    await h.dispatcher.tick()
    expect(reduceBuild(await h.events(node.slug)).status).toBe('done')
    expect((await h.tickets.get('NODE'))?.state).toBe('Done')
  } finally {
    await h.cleanup()
  }
})

test('nodes open at full work capacity and abort immediately closes admission', async () => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: CONFIG_TOML.replace('capacity = 2', 'capacity = 1'),
    handlers: happyHandlers(),
    tickets: [
      readyTicket('WORK', { title: 'Ordinary work' }),
      { ...readyTicket('NODE', { title: 'Integration node' }), kind: 'node' },
      { ...readyTicket('CHILD', { title: 'Targeted work' }), target: 'NODE' },
    ],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'NODE')!
    expect(reduceBuild(await h.events(node.slug)).status).toBe('collecting')
    expect(h.launched).toHaveLength(1)
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: node.slug,
      action: { kind: 'abort' },
    })
    await h.dispatcher.tick()
    // Saturated work-only intake retains the historical fast path. Finish the
    // existing work before asking the admission scan for target diagnostics.
    await h.runLatest()
    const work = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'WORK')!
    const workState = reduceBuild(await h.events(work.slug))
    await h.forgeAdapter.squashMerge(h.origin, workState.pr!.number, workState.pr!.headSha)
    h.clock.advance(60_000)
    const report = await h.dispatcher.tick()
    expect(report.dependencyDiagnostics.join(' ')).toContain('closed')
    expect((await h.store.listBuilds()).some((r) => r.ticket?.id === 'CHILD')).toBe(false)
    expect(h.launched.every((r) => r.slug !== node.slug)).toBe(true)
  } finally {
    await h.cleanup()
  }
})

test('root movement cascades through nested nodes with owned foreign history and no agent sessions', async () => {
  const { git, commitAll } = await import('./harness')
  const { join } = await import('node:path')
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('A', { title: 'Node alpha' }), kind: 'node' },
      { ...readyTicket('B', { title: 'Node beta' }), kind: 'node', target: 'A' },
      { ...readyTicket('C', { title: 'Node gamma' }), kind: 'node', target: 'B' },
    ],
  })
  try {
    for (let i = 0; i < 4; i++) await h.dispatcher.tick()
    const nodes = (await h.store.listBuilds()).filter((r) => r.branch?.startsWith('ab-node/'))
    expect(nodes).toHaveLength(3)
    const a = nodes.find((r) => r.ticket?.id === 'A')!
    const b = nodes.find((r) => r.ticket?.id === 'B')!
    const c = nodes.find((r) => r.ticket?.id === 'C')!
    const foreign = async (branch: string, filename: string) => {
      const ws = join(h.tmp, filename)
      await git(['worktree', 'add', ws, branch], h.origin)
      await Bun.write(join(ws, filename), filename)
      await commitAll(ws, `Foreign ${filename}`)
      await git(['worktree', 'remove', ws], h.origin)
    }
    await foreign(a.branch!, 'foreign-a')
    for (let i = 0; i < 4; i++) await h.dispatcher.tick()
    await foreign(b.branch!, 'foreign-b')
    for (let i = 0; i < 4; i++) await h.dispatcher.tick()
    const before = new Map(nodes.map((r) => [r.slug, reduceBuild([]).pr]))
    for (const r of nodes) before.set(r.slug, reduceBuild(await h.events(r.slug)).pr)
    for (const round of [1, 2]) {
      await Bun.write(join(h.origin, `upstream-${round}`), `upstream ${round}`)
      const root = await commitAll(h.origin, `Root movement ${round}`)
      for (let i = 0; i < 5; i++) await h.dispatcher.tick()
      for (const r of nodes) {
        expect(await git(['merge-base', '--is-ancestor', root, r.branch!], h.origin)).toBe('')
        expect(await git(['show', `${r.branch}:foreign-a`], h.origin)).toBe('foreign-a')
        expect(reduceBuild(await h.events(r.slug)).pr?.number).toBe(before.get(r.slug)?.number)
      }
      expect(await git(['show', `${c.branch}:foreign-b`], h.origin)).toBe('foreign-b')
      expect(reduceBuild(await h.events(a.slug)).nodeRestack?.inventory?.foreign).toHaveLength(1)
      expect(reduceBuild(await h.events(b.slug)).nodeRestack?.inventory?.foreign).toHaveLength(1)
      expect(reduceBuild(await h.events(c.slug)).nodeRestack?.inventory?.foreign).toHaveLength(0)
    }
    expect(h.launched).toHaveLength(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('node conflict runner resolves the source build with its own spec and plan', async () => {
  const { git, commitAll } = await import('./harness')
  const { join } = await import('node:path')
  let sourceSlug = ''
  let ownerSlug = ''
  let sourceSpec = ''
  let resolved = 0
  const h = await makeHarness({
    localGitForge: true,
    handlers: {
      ...happyHandlers(),
      reconcile: async (cli) => {
        await cli.run(['context'])
        const manifest = await Bun.file(join(cli.ws, '.ab/context.json')).json()
        expect(manifest.nodeChange).toMatchObject({
          owner: ownerSlug,
          build: sourceSlug,
          foreign: false,
        })
        expect(await Bun.file(join(cli.ws, '.ab/spec.md')).text()).toBe(sourceSpec)
        expect(await Bun.file(join(cli.ws, '.ab/plan.md')).text()).toContain('Add rate-limit.txt')
        await Bun.write(join(cli.ws, 'rate-limit.txt'), 'preserve root and source intent\n')
        await git(['add', 'rate-limit.txt'], cli.ws)
        await git(['-c', 'core.editor=true', 'cherry-pick', '--continue'], cli.ws)
        await Bun.write(join(cli.ws, '.ab/reconcile-notes.md'), 'Preserved both sides.\n')
        await cli.run(['done', '--notes', join(cli.ws, '.ab/reconcile-notes.md')])
        resolved++
      },
    },
    tickets: [
      { ...readyTicket('NODE', { title: 'Node owner' }), kind: 'node' },
      { ...readyTicket('CHILD', { title: 'Child source' }), target: 'NODE' },
    ],
  })
  try {
    await h.dispatcher.tick()
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const records = await h.store.listBuilds()
    const owner = records.find((r) => r.ticket?.id === 'NODE')!
    const source = records.find((r) => r.ticket?.id === 'CHILD')!
    sourceSpec = new TextDecoder().decode((await h.store.getArtifact(source.slug, 'spec'))!.content)
    sourceSlug = source.slug
    ownerSlug = owner.slug
    await h.runLatest()
    const child = reduceBuild(await h.events(source.slug))
    await h.forgeAdapter.squashMerge(h.origin, child.pr!.number, child.pr!.headSha, {
      buildSlug: source.slug,
    })
    await h.dispatcher.tick()
    await Bun.write(join(h.origin, 'rate-limit.txt'), 'new root behavior\n')
    await commitAll(h.origin, 'Root conflicts with source')
    await h.dispatcher.tick()
    const conflictState = reduceBuild(await h.events(owner.slug))
    expect(conflictState.nodeRestack?.conflict).toBeDefined()
    await h.dispatcher.tick()
    await h.dispatcher.drainProvisioning()
    expect(h.launched.at(-1)?.slug).toBe(owner.slug)
    await h.runLatest()
    expect(resolved).toBe(1)
    await h.dispatcher.tick()
    const state = reduceBuild(await h.events(owner.slug))
    expect(state.nodeRestack?.active).toBeUndefined()
    expect(state.nodeRestack?.inventory?.builds).toContain(source.slug)
    expect(await git(['show', `${owner.branch}:rate-limit.txt`], h.origin)).toBe(
      'preserve root and source intent',
    )
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('node-target consent lands the canonical leaf without native auto-merge', async () => {
  const { git } = await import('./harness')
  const { humanActor } = await import('../events/envelope')
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('NODE', { title: 'Destination node' }), kind: 'node' },
      { ...readyTicket('CHILD', { title: 'Consenting child' }), target: 'NODE' },
    ],
  })
  try {
    await h.dispatcher.tick()
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const records = await h.store.listBuilds()
    const owner = records.find((r) => r.ticket?.id === 'NODE')!
    const child = records.find((r) => r.ticket?.id === 'CHILD')!
    await h.store.append(child.slug, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    await h.runLatest()
    expect(ofType(await h.events(child.slug), 'pr.auto-merge-enabled')).toHaveLength(0)
    const canonical = await git(['rev-parse', child.branch!], h.origin)
    await h.dispatcher.tick()
    const state = reduceBuild(await h.events(child.slug))
    expect(state.status).toBe('done')
    expect(state.mergedSha).toBe(canonical)
    expect(await git(['rev-parse', owner.branch!], h.origin)).toBe(canonical)
    expect(ofType(await h.events(owner.slug), 'node.writer-reserved')[0]?.payload.operation).toBe(
      'landing',
    )
    expect(reduceBuild(await h.events(owner.slug)).status).toBe('collecting')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('unsafe foreign merge escalates once without moving the node and an authorized retry resamples upstream', async () => {
  const { git, commitAll } = await import('./harness')
  const { humanActor } = await import('../events/envelope')
  const { join } = await import('node:path')
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [{ ...readyTicket('NODE', { title: 'Foreign merge node' }), kind: 'node' }],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    const ws = join(h.tmp, 'foreign-merge')
    await git(['worktree', 'add', ws, node.branch!], h.origin)
    await Bun.write(join(ws, 'owned'), 'owned')
    await commitAll(ws, 'Owned foreign')
    await git(['checkout', '-b', 'side-identity', 'main'], ws)
    await Bun.write(join(ws, 'side'), 'side')
    const side = await commitAll(ws, 'Side\n\nAutobuild-Build: missing-side')
    await git(['checkout', node.branch!], ws)
    await git(
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@test.invalid',
        '-c',
        'commit.gpgsign=false',
        'merge',
        '--no-ff',
        'side-identity',
        '-m',
        'Foreign merge',
      ],
      ws,
    )
    const original = await git(['rev-parse', 'HEAD'], ws)
    await git(['worktree', 'remove', ws], h.origin)
    await Bun.write(join(h.origin, 'root-move'), 'root moved')
    await commitAll(h.origin, 'Move root')
    await h.dispatcher.tick()
    await h.dispatcher.tick()
    const blocked = reduceBuild(await h.events(node.slug))
    expect(blocked.status).toBe('blocked')
    expect(blocked.openEscalations).toHaveLength(1)
    expect(blocked.openEscalations[0]?.question).toContain(original)
    expect(blocked.openEscalations[0]?.question).toContain('missing-side')
    expect(await git(['rev-parse', node.branch!], h.origin)).toBe(original)
    await git(
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@test.invalid',
        '-c',
        'commit.gpgsign=false',
        'cherry-pick',
        side,
      ],
      h.origin,
    )
    await h.store.append(node.slug, {
      actor: humanActor('operator'),
      type: 'escalation.answered',
      payload: {
        id: blocked.openEscalations[0]!.id,
        answer: 'The missing identity is now upstream; retry the proof.',
        resolution: 'guidance',
      },
    })
    await h.dispatcher.tick()
    const completed = reduceBuild(await h.events(node.slug))
    expect(completed.nodeRestack?.active).toBeUndefined()
    expect(completed.nodeRestack?.inventory?.builds).toContain('missing-side')
    expect(completed.nodeRestack?.inventory?.foreign).toHaveLength(2)
    expect(h.launched).toHaveLength(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)
