import { requestNodeRestack } from '../operator/restack'
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
      autoMerge: true,
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
    expect(h.launched.some((r) => r.slug === node.slug)).toBe(true)
    await h.runLatest()
    h.clock.advance(180_000)
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

test('operator demand advances nested nodes through kernel restacks', async () => {
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
    await requestNodeRestack({ store: h.store, repo: h.origin, slug: b.slug, user: 'operator' })
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    await foreign(b.branch!, 'foreign-b')
    for (let i = 0; i < 4; i++) await h.dispatcher.tick()
    const before = new Map(nodes.map((r) => [r.slug, reduceBuild([]).pr]))
    for (const r of nodes) before.set(r.slug, reduceBuild(await h.events(r.slug)).pr)
    for (const round of [1, 2]) {
      await Bun.write(join(h.origin, `upstream-${round}`), `upstream ${round}`)
      const root = await commitAll(h.origin, `Root movement ${round}`)
      for (const node of [a, b, c]) {
        await requestNodeRestack({
          store: h.store,
          repo: h.origin,
          slug: node.slug,
          user: 'operator',
        })
        for (let i = 0; i < 3; i++) await h.dispatcher.tick()
      }
      expect(
        ofType(await h.events(a.slug), 'target.moved').filter(
          (event) => event.payload.sha === root,
        ),
      ).toHaveLength(1)
      expect(await git(['merge-base', '--is-ancestor', root, a.branch!], h.origin)).toBe('')
      expect(await git(['show', `${a.branch}:foreign-a`], h.origin)).toBe('foreign-a')
      for (const r of nodes)
        expect(reduceBuild(await h.events(r.slug)).pr?.number).toBe(before.get(r.slug)?.number)
      for (const child of [b, c]) {
        expect(reduceBuild(await h.events(child.slug)).targetRewrite).toBeUndefined()
        expect(await git(['merge-base', '--is-ancestor', root, child.branch!], h.origin)).toBe('')
      }
      expect(await git(['show', `${b.branch}:foreign-b`], h.origin)).toBe('foreign-b')
      expect(reduceBuild(await h.events(a.slug)).nodeRestack?.inventory?.foreign).toHaveLength(1)
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
    configToml: CONFIG_TOML.replace('capacity = 2', 'capacity = 1'),
    handlers: {
      ...happyHandlers(),
      reconcile: async (cli) => {
        await cli.run(['context'])
        const manifest = await Bun.file(join(cli.ws, cli.env.contextDir!, 'context.json')).json()
        expect(manifest.nodeChange).toMatchObject({
          owner: ownerSlug,
          build: sourceSlug,
          foreign: false,
        })
        expect(await Bun.file(join(cli.ws, cli.env.contextDir!, 'spec.md')).text()).toBe(sourceSpec)
        expect(await Bun.file(join(cli.ws, cli.env.contextDir!, 'plan.md')).text()).toContain(
          'Add rate-limit.txt',
        )
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
    h.tickets.add({
      ...readyTicket('OPEN', { title: 'Keep node collecting' }),
      state: 'Backlog',
      target: 'NODE',
    })
    h.tickets.add(readyTicket('BUSY', { title: 'Occupy the runner slot' }))
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const busy = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'BUSY')!
    await Bun.write(join(h.origin, 'rate-limit.txt'), 'new root behavior\n')
    await commitAll(h.origin, 'Root conflicts with source')
    await requestNodeRestack({ store: h.store, repo: h.origin, slug: owner.slug, user: 'operator' })
    await h.dispatcher.tick()
    const conflictState = reduceBuild(await h.events(owner.slug))
    expect(conflictState.nodeRestack?.conflict).toBeDefined()
    await h.dispatcher.tick()
    await h.dispatcher.drainProvisioning()
    h.clock.advance(180_000)
    await h.dispatcher.tick()
    expect(h.launched.filter((entry) => entry.slug === owner.slug)).toHaveLength(0)
    expect(ofType(await h.events(owner.slug), 'workspace.provisioned')).toHaveLength(0)
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: busy.slug,
      action: { kind: 'abort' },
    })
    await h.dispatcher.tick()
    await h.dispatcher.tick()
    await h.dispatcher.drainProvisioning()
    expect(h.launched.at(-1)?.slug).toBe(owner.slug)
    await h.runLatest()
    expect(resolved).toBe(1)
    // A dead local supervisor can leave execution.started after the resolver
    // receipt; no provider command id exists to settle it out of process.
    const { readBuildFacts } = await import('../store/reduced-reads')
    const { DISPATCHER } = await import('../events/envelope')
    const facts = (await readBuildFacts(h.store, owner.slug)).value
    await h.store.append(owner.slug, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        instance: 'crashed-local',
        provider: 'git-worktree',
        workspaceRef: facts.workspace!.ref,
      },
    })
    h.clock.advance(120_000)
    expect((await h.dispatcher.tick()).janitorFailed).toBe(0)
    expect((await readBuildFacts(h.store, owner.slug)).value.open).toBeNull()
    expect(ofType(await h.events(owner.slug), 'execution.ended').at(-1)?.payload.outcome).toBe(
      'lost',
    )
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

for (const waiting of ['blocked', 'paused'] as const)
  test(`capacity five launches an answered existing node conflict with three ${waiting} descendants`, async () => {
    const { git, commitAll } = await import('./harness')
    const { join } = await import('node:path')
    let sourceSlug = ''
    let ownerSlug = ''
    let sourceSpec = ''
    let resolved = 0
    const h = await makeHarness({
      localGitForge: true,
      configToml: CONFIG_TOML.replace('capacity = 2', 'capacity = 5'),
      handlers: {
        ...happyHandlers(),
        reconcile: async (cli) => {
          await cli.run(['context'])
          const manifest = await Bun.file(join(cli.ws, cli.env.contextDir!, 'context.json')).json()
          expect(manifest.nodeChange).toMatchObject({
            owner: ownerSlug,
            build: sourceSlug,
            foreign: false,
          })
          expect(await Bun.file(join(cli.ws, cli.env.contextDir!, 'spec.md')).text()).toBe(
            sourceSpec,
          )
          expect(await Bun.file(join(cli.ws, cli.env.contextDir!, 'plan.md')).text()).toContain(
            'Add rate-limit.txt',
          )
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
      sourceSpec = new TextDecoder().decode(
        (await h.store.getArtifact(source.slug, 'spec'))!.content,
      )
      sourceSlug = source.slug
      ownerSlug = owner.slug
      await h.runLatest()
      const child = reduceBuild(await h.events(source.slug))
      await h.forgeAdapter.squashMerge(h.origin, child.pr!.number, child.pr!.headSha, {
        buildSlug: source.slug,
      })
      await h.dispatcher.tick()
      h.tickets.add({
        ...readyTicket('OPEN', { title: 'Keep node collecting' }),
        state: 'Backlog',
        target: 'NODE',
      })
      h.tickets.add(readyTicket('BUSY', { title: 'Occupy the runner slot' }))
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      const busy = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'BUSY')!
      await h.store.append(busy.slug, {
        actor: { kind: 'kernel' },
        type: 'runner.attached',
        payload: { instance: 'unrelated-runner', host: 'test' },
      })
      await Bun.write(join(h.origin, 'rate-limit.txt'), 'new root behavior\n')
      await commitAll(h.origin, 'Root conflicts with source')
      await requestNodeRestack({
        store: h.store,
        repo: h.origin,
        slug: owner.slug,
        user: 'operator',
      })
      // Two unrelated running builds and three blocked descendants fill all five slots.
      const { DISPATCHER: actor } = await import('../events/envelope')
      for (const [index, target] of [undefined, owner.slug, owner.slug, owner.slug].entries()) {
        const slug = `capacity-holder-${index}`
        await h.store.createBuild({
          slug,
          repo: h.origin,
          ticket: { source: 'fake', id: slug },
          created: {
            actor,
            type: 'build.created',
            payload: {
              repo: h.origin,
              baseBranch: target ? owner.branch! : 'main',
              ticket: { source: 'fake', id: slug },
              ...(target ? { target: { build: target, ticket: owner.ticket! } } : {}),
            },
          },
        })
        await h.store.append(slug, {
          actor: { kind: 'kernel' },
          type: 'runner.attached',
          payload: { instance: slug, host: 'test' },
        })
      }
      await h.dispatcher.tick()
      const conflictState = reduceBuild(await h.events(owner.slug))
      expect(conflictState.nodeRestack?.conflict).toBeDefined()
      expect(h.launched.filter((entry) => entry.slug === owner.slug)).toHaveLength(0)
      for (let index = 1; index <= 3; index++) {
        if (waiting === 'paused')
          await h.store.append(`capacity-holder-${index}`, {
            actor,
            type: 'build.paused',
            payload: {},
          })
        else
          await h.store.append(`capacity-holder-${index}`, {
            actor: { kind: 'kernel' },
            type: 'escalation.raised',
            payload: {
              id: `blocked-${index}`,
              source: 'agent',
              phase: 'implement',
              question: 'Waiting on the node restack',
            },
          })
      }
      await h.store.append(owner.slug, {
        actor: { kind: 'kernel' },
        type: 'escalation.raised',
        payload: {
          id: 'node-guidance',
          source: 'agent',
          phase: 'reconcile',
          question: 'Resolve the source conflict?',
        },
      })
      await h.store.append(owner.slug, {
        actor: { kind: 'human', user: 'test' },
        type: 'escalation.answered',
        payload: {
          id: 'node-guidance',
          answer: 'Preserve both intents',
          resolution: 'guidance',
        },
      })
      h.tickets.add(readyTicket('COMPETITOR', { title: 'New ticket must wait' }))
      await h.dispatcher.tick()
      await h.dispatcher.drainProvisioning()
      expect(
        (await h.store.listBuilds()).some((record) => record.ticket?.id === 'COMPETITOR'),
      ).toBe(false)
      const nodeRunner = h.launched.find((entry) => entry.slug === owner.slug)!
      expect(nodeRunner).toBeDefined()
      await nodeRunner.runner.run()
      await h.store.releaseLease(nodeRunner.slug, nodeRunner.instance)
      expect(resolved).toBe(1)
      // A dead local supervisor can leave execution.started after the resolver
      // receipt; no provider command id exists to settle it out of process.
      const { readBuildFacts } = await import('../store/reduced-reads')
      const { DISPATCHER } = await import('../events/envelope')
      const facts = (await readBuildFacts(h.store, owner.slug)).value
      await h.store.append(owner.slug, {
        actor: DISPATCHER,
        type: 'execution.started',
        payload: {
          instance: 'crashed-local',
          provider: 'git-worktree',
          workspaceRef: facts.workspace!.ref,
        },
      })
      h.clock.advance(120_000)
      expect((await h.dispatcher.tick()).janitorFailed).toBe(0)
      expect((await readBuildFacts(h.store, owner.slug)).value.open).toBeNull()
      expect(ofType(await h.events(owner.slug), 'execution.ended').at(-1)?.payload.outcome).toBe(
        'lost',
      )
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
    await requestNodeRestack({ store: h.store, repo: h.origin, slug: node.slug, user: 'operator' })
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

for (const command of ['abort', 'pause'] as const) {
  test(`a live node conflict runner owns ${command} acknowledgement until its turn ends`, async () => {
    const { git, commitAll } = await import('./harness')
    const { join } = await import('node:path')
    const { access } = await import('node:fs/promises')
    const { readBuildFacts } = await import('../store/reduced-reads')
    const { KERNEL } = await import('../events/envelope')
    let nodeSlug = ''
    let resolverPath = ''
    let lateReceipt: import('../events/payloads').EventPayload<'node.item-replayed'> | undefined
    let turns = 0
    const h = await makeHarness({
      localGitForge: true,
      handlers: {
        ...happyHandlers(),
        reconcile: async (cli) => {
          turns++
          resolverPath = cli.ws
          const before = (await readBuildFacts(h.store, nodeSlug)).value.state
          const lease = (await h.store.getBuild(nodeSlug))!.lease!
          expect(lease).toBeDefined()
          const node = before.nodeRestack!
          lateReceipt = {
            id: node.active!.id,
            index: node.conflict!.index,
            base: node.conflict!.base,
            head: 'e'.repeat(40),
            dropped: false,
          }
          await controlBuild({
            store: h.store,
            repo: h.origin,
            slug: nodeSlug,
            action: { kind: command },
          })
          const report = await h.dispatcher.tick()
          expect(report.janitorFailed).toBe(0)
          const during = (await readBuildFacts(h.store, nodeSlug)).value.state
          expect(during.pendingCommands.some((intent) => intent.command === command)).toBe(true)
          expect(during.status).toBe('collecting')
          expect(during.nodeRestack?.active?.id).toBe(node.active!.id)
          expect((await h.store.getBuild(nodeSlug))!.lease?.holder).toBe(lease.holder)
          await access(cli.ws)
          // Return the live turn without completing its item: the runner's next
          // engine decision acknowledges the pending command before another phase.
        },
      },
      tickets: [{ ...readyTicket('NODE', { title: 'Controlled conflict node' }), kind: 'node' }],
    })
    try {
      await h.dispatcher.tick()
      const record = (await h.store.listBuilds())[0]!
      nodeSlug = record.slug
      const ws = join(h.tmp, 'foreign-control')
      await git(['worktree', 'add', ws, record.branch!], h.origin)
      await Bun.write(join(ws, 'collision'), 'node intent\n')
      await commitAll(ws, 'Foreign node change')
      await git(['worktree', 'remove', ws], h.origin)
      await h.dispatcher.tick()
      await Bun.write(join(h.origin, 'collision'), 'parent intent\n')
      await commitAll(h.origin, 'Conflicting root change')
      await requestNodeRestack({ store: h.store, repo: h.origin, slug: nodeSlug, user: 'operator' })
      await h.dispatcher.tick()
      await h.dispatcher.drainProvisioning()
      expect(h.launched.at(-1)?.slug).toBe(nodeSlug)
      await h.runLatest()
      expect(turns).toBe(1)
      expect((await readBuildFacts(h.store, nodeSlug)).value.state.status).toBe(
        command === 'abort' ? 'aborted' : 'paused',
      )
      const report = await h.dispatcher.tick()
      expect(report.janitorFailed).toBe(0)
      if (command === 'abort') {
        expect(
          (await readBuildFacts(h.store, nodeSlug)).value.state.nodeRestack?.active,
        ).toBeUndefined()
        await expect(access(resolverPath)).rejects.toThrow()
        // Old logs may already contain the pre-fix settlement/late-receipt
        // race. Both direct and persisted reductions must remain readable.
        await h.store.append(nodeSlug, {
          actor: KERNEL,
          type: 'node.item-replayed',
          payload: lateReceipt!,
        })
        expect(reduceBuild(await h.events(nodeSlug)).nodeRestack?.active).toBeUndefined()
        expect(
          (await readBuildFacts(h.store, nodeSlug)).value.state.nodeRestack?.active,
        ).toBeUndefined()
      } else {
        await access(resolverPath)
        expect(
          (await readBuildFacts(h.store, nodeSlug)).value.state.nodeRestack?.conflict,
        ).toBeDefined()
      }
    } finally {
      await h.cleanup()
    }
  }, 30_000)
}

for (const checkout of ['scratch', 'absent'] as const) {
  test(`origin-mode ${checkout} checkout supports node cascades and guarded child landing`, async () => {
    const { git, commitAll } = await import('./harness')
    const { join } = await import('node:path')
    const { mkdir } = await import('node:fs/promises')
    const { Dispatcher } = await import('../processes/dispatcher')
    const { GitHubForge } = await import('../ports/forge/github')
    const { spawnExec } = await import('../ports/workspace/git-worktree')
    const { humanActor } = await import('../events/envelope')
    const h = await makeHarness({
      localGitForge: true,
      handlers: happyHandlers(),
      tickets: [
        { ...readyTicket('NODE', { title: 'Origin destination' }), kind: 'node' },
        { ...readyTicket('CHILD', { title: 'Origin child' }), target: 'NODE' },
      ],
    })
    try {
      // The local harness owns runner setup. The checkout-less dispatcher below
      // uses Git transport for every node mutation, as a hosted forge does.
      await h.dispatcher.tick()
      const node = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'NODE')!
      const scratch = join(h.tmp, 'dispatch-scratch')
      await mkdir(scratch)
      const origin = 'https://github.com/acme/private-repo'
      // The HTTPS transport shim maps this served repository to a local remote.
      // Build worktrees must retain its named origin for preservation snapshots.
      await git(['remote', 'add', 'origin', h.origin], h.origin)
      const token = 'fixture-private-token'
      const activity: string[] = []
      const claimWriter = h.store.claimNodeWriter.bind(h.store)
      h.store.claimNodeWriter = async (...args) => {
        activity.push('claim')
        return claimWriter(...args)
      }
      const transport = new GitHubForge({
        repository: origin,
        token,
        exec: async (cmd, opts) => {
          // Fail every credential-less host transport attempt, including
          // clone, fetch, archive push, readback and destination CAS.
          expect(opts.env?.GIT_CONFIG_VALUE_4).toBe(
            `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
          )
          expect(opts.env?.GIT_CONFIG_KEY_4).toBe(`http.${origin}.extraHeader`)
          expect(cmd.join(' ')).not.toContain(token)
          activity.push(cmd[1]!)
          if (cmd[1] === 'clone') {
            // A download slower than the writer TTL must still converge.
            h.clock.advance(65_000)
          }
          // The fixture models the credentialed HTTPS endpoint with real Git
          // transport to a local repository only after validating credentials.
          return spawnExec(
            cmd.map((arg) => (arg === origin ? h.origin : arg)),
            opts,
          )
        },
      })
      const apiMethods = new Set([
        'getPrState',
        'inspectLandingPr',
        'setAutoMerge',
        'closePr',
        'commentOnPr',
        'containsBuild',
        'readCommitMessage',
      ])
      const forge = new Proxy(h.forgeAdapter, {
        get(target, key) {
          if (key === 'kernelExec') return transport.kernelExec
          if (key === 'kernelRewrite') return transport.kernelRewrite
          if (key === 'rewrite') return transport.rewrite
          if (key === 'snapshotBase') return undefined
          if (key === 'openPr')
            return (input: Parameters<NonNullable<typeof target.openPr>>[0]) =>
              target.openPr({ ...input, workspacePath: h.origin })
          const value = Reflect.get(target, key, target)
          if (typeof value !== 'function') return value
          // API observations live at the served origin, independently of cwd.
          return apiMethods.has(String(key))
            ? (...args: unknown[]) => Reflect.apply(value, target, [h.origin, ...args.slice(1)])
            : value.bind(target)
        },
      })
      const dispatcher = new Dispatcher({
        store: h.store,
        tickets: h.tickets,
        workspaces: h.workspaces,
        forge,
        config: h.config,
        repo: h.origin,
        repoOrigin: origin,
        ...(checkout === 'scratch' ? { checkout: scratch } : {}),
        exec: async (cmd, opts) => {
          if (['clone', 'fetch', 'push', 'ls-remote'].includes(cmd[1]!))
            throw new Error('uncredentialed host Git transport')
          return spawnExec(cmd, opts)
        },
        ids: h.ids,
        clock: h.clock,
        launchRunner: async () => {
          throw new Error('clean origin cascade launched an agent')
        },
      })
      const original = await git(['rev-parse', node.branch!], h.origin)
      await Bun.write(join(h.origin, 'origin-upstream'), 'upstream')
      const root = await commitAll(h.origin, 'Origin parent movement')
      await requestNodeRestack({
        store: h.store,
        repo: h.origin,
        slug: node.slug,
        user: 'operator',
      })
      expect((await dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
      expect(await git(['rev-parse', node.branch!], h.origin)).toBe(root)
      expect(ofType(await h.events(node.slug), 'node.rewritten')).toHaveLength(1)
      expect(original).not.toBe(root)
      expect(activity.indexOf('clone')).toBeLessThan(activity.indexOf('claim'))
      // Settlement invalidates the immutable distance sample; refresh it once.
      await dispatcher.tick({ acceptNewWork: false })
      const idleActivity = activity.length
      for (let i = 0; i < 2; i++)
        expect((await dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
      expect(activity).toHaveLength(idleActivity)
      expect(
        (await spawnExec(['git', 'rev-parse', '--git-dir'], { cwd: scratch })).exitCode,
      ).not.toBe(0)

      h.clock.advance(60_000)
      await h.dispatcher.tick()
      const child = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'CHILD')!
      await h.store.append(child.slug, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
      await h.runLatest()
      const canonical = await git(['rev-parse', child.branch!], h.origin)
      const writerFacts = ofType(await h.events(node.slug), 'node.writer-reserved').length
      const beforeDeferral = activity.length
      const ungated = h.forgeAdapter.inspectLandingGate!.bind(h.forgeAdapter)
      for (const kind of ['gated', 'unproven'] as const) {
        h.forgeAdapter.inspectLandingGate = async () => ({ kind, reason: 'Repository policy' })
        for (let i = 0; i < 3; i++)
          expect((await dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
      }
      expect(activity).toHaveLength(beforeDeferral)
      expect(ofType(await h.events(node.slug), 'node.writer-reserved')).toHaveLength(writerFacts)
      h.forgeAdapter.inspectLandingGate = ungated
      expect((await dispatcher.tick({ acceptNewWork: false })).janitorFailed).toBe(0)
      expect(reduceBuild(await h.events(child.slug)).mergedSha).toBe(canonical)
      expect(await git(['rev-parse', node.branch!], h.origin)).toBe(canonical)
      expect(ofType(await h.events(child.slug), 'pr.auto-merge-enabled')).toHaveLength(0)
      expect(ofType(await h.events(node.slug), 'node.writer-settled').at(-1)?.payload.outcome).toBe(
        'completed',
      )
    } finally {
      await h.cleanup()
    }
  }, 30_000)
}

for (const conflict of [false, true]) {
  test(`node-target finalize commits are collapsed before guarded landing (reconciled: ${conflict})`, async () => {
    const { git, commitAll } = await import('./harness')
    const { join } = await import('node:path')
    const { humanActor } = await import('../events/envelope')
    const configToml = `${CONFIG_TOML.replace(
      'test = "test -f ok.marker"',
      'test = "test -f ok.marker"\npost = "touch post.marker && git add post.marker && git commit -m post"',
    )}\n[finalize]\nsteps = ["post"]\n[finalize.post]\nkind = "check"\ncommand = "post"\n`
    const happy = happyHandlers()
    let nodeBranch = ''
    let reconciliations = 0
    const h = await makeHarness({
      localGitForge: true,
      configToml,
      handlers: {
        ...happy,
        implement: async (cli) => {
          await happy.implement!(cli)
          if (conflict) {
            const ws = join(h.tmp, 'node-movement')
            await git(['worktree', 'add', ws, nodeBranch], h.origin)
            await Bun.write(join(ws, 'rate-limit.txt'), 'upstream node behavior\n')
            await commitAll(ws, 'Move node before leaf verify entry')
            await git(['worktree', 'remove', ws], h.origin)
          }
        },
        reconcile: async (cli) => {
          reconciliations++
          await Bun.write(join(cli.ws, 'rate-limit.txt'), 'preserve upstream and child behavior\n')
          await git(['add', 'rate-limit.txt'], cli.ws)
          await git(['-c', 'core.editor=true', 'cherry-pick', '--continue'], cli.ws)
          const notes = join(cli.ws, '.ab/reconcile-notes.md')
          await Bun.write(notes, 'Preserved upstream and child behavior.\n')
          await cli.run(['done', '--notes', notes])
        },
      },
      tickets: [
        { ...readyTicket('NODE', { title: 'Finalize destination' }), kind: 'node' },
        { ...readyTicket('CHILD', { title: 'Finalize child' }), target: 'NODE' },
      ],
    })
    try {
      await h.dispatcher.tick()
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      const records = await h.store.listBuilds()
      const node = records.find((record) => record.ticket?.id === 'NODE')!
      const child = records.find((record) => record.ticket?.id === 'CHILD')!
      nodeBranch = node.branch!
      await h.store.append(child.slug, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
      await h.runLatest()
      expect(reconciliations).toBe(conflict ? 1 : 0)
      const postStep = ofType(await h.events(child.slug), 'finalize.step-completed')[0]?.payload
      expect(postStep?.ok && postStep.headSha).toBeTruthy()
      const canonical = await git(['rev-parse', child.branch!], h.origin)
      const parent = await git(['rev-parse', `${child.branch}^`], h.origin)
      expect(parent).toBe(await git(['rev-parse', node.branch!], h.origin))
      expect(await git(['show', `${child.branch}:post.marker`], h.origin)).toBe('')
      const message = await git(['show', '-s', '--format=%B', canonical], h.origin)
      expect(message.match(/Autobuild-Build:/g)).toHaveLength(1)
      expect(message).toContain(`Autobuild-Build: ${child.slug}`)
      if (conflict)
        expect(await git(['show', `${child.branch}:rate-limit.txt`], h.origin)).toBe(
          'preserve upstream and child behavior',
        )
      const observations = ofType(await h.events(child.slug), 'target.moved').length
      expect((await h.dispatcher.tick()).janitorFailed).toBe(0)
      expect(reduceBuild(await h.events(child.slug)).status).toBe('done')
      expect(await git(['rev-parse', node.branch!], h.origin)).toBe(canonical)
      expect(ofType(await h.events(child.slug), 'target.moved')).toHaveLength(observations)
    } finally {
      await h.cleanup()
    }
  }, 30_000)
}

for (const providerState of ['merged', 'closed'] as const) {
  test(`node landing settles its reservation before completing a ${providerState} leaf inside writer TTL`, async () => {
    const { git } = await import('./harness')
    const { humanActor } = await import('../events/envelope')
    const h = await makeHarness({
      localGitForge: true,
      handlers: happyHandlers(),
      tickets: [
        { ...readyTicket('NODE', { title: 'Crash destination' }), kind: 'node' },
        { ...readyTicket('CHILD', { title: 'Crash leaf' }), target: 'NODE' },
      ],
    })
    try {
      await h.dispatcher.tick()
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      const records = await h.store.listBuilds()
      const node = records.find((record) => record.ticket?.id === 'NODE')!
      const child = records.find((record) => record.ticket?.id === 'CHILD')!
      await h.store.append(child.slug, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
      await h.runLatest()
      const canonical = await git(['rev-parse', child.branch!], h.origin)
      const append = h.store.appendIfCurrent.bind(h.store)
      let crash = true
      h.store.appendIfCurrent = async (...args) => {
        if (args[0] === node.slug && args[2].type === 'node.rewritten' && crash) {
          crash = false
          throw new Error('dispatcher dies after push')
        }
        return append(...args)
      }
      expect((await h.dispatcher.tick()).janitorFailed).toBe(1)
      expect(await git(['rev-parse', node.branch!], h.origin)).toBe(canonical)
      // The crashed process's writer lease has not expired on restart.
      expect(await h.store.claimNodeWriter(node.slug, 'dead-dispatcher', 60_000)).toBe(true)
      const childPr = reduceBuild(await h.events(child.slug)).pr!.number
      const getPr = h.forgeAdapter.getPrState.bind(h.forgeAdapter)
      h.forgeAdapter.getPrState = async (cwd, number) =>
        number === childPr
          ? providerState === 'merged'
            ? { state: 'merged', sha: canonical }
            : { state: 'closed' }
          : getPr(cwd, number)
      expect((await h.dispatcher.tick()).janitorFailed).toBe(0)
      expect(reduceBuild(await h.events(child.slug)).status).not.toBe('done')
      expect(reduceBuild(await h.events(node.slug)).nodeRestack?.active?.source).toBe(child.slug)
      h.clock.advance(60_000)
      expect((await h.dispatcher.tick()).janitorFailed).toBe(0)
      expect(reduceBuild(await h.events(node.slug)).nodeRestack?.active).toBeUndefined()
      expect(reduceBuild(await h.events(child.slug)).mergedSha).toBe(canonical)
      expect(reduceBuild(await h.events(child.slug)).status).toBe('done')
    } finally {
      await h.cleanup()
    }
  }, 30_000)
}

test('complete nodes verify and land a linear stack only after explicit consent', async () => {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('NODE', { title: 'Release node' }), kind: 'node' },
      { ...readyTicket('CHILD', { title: 'Release child' }), target: 'NODE' },
    ],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'NODE')!
    await expect(
      controlBuild({
        store: h.store,
        repo: h.origin,
        slug: node.slug,
        action: { kind: 'land' },
        ticketSource: async () => h.tickets,
      }),
    ).rejects.toThrow('not ready')
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    await h.runLatest()
    const child = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'CHILD')!
    const childState = reduceBuild(await h.events(child.slug))
    await h.forgeAdapter.squashMerge(h.origin, childState.pr!.number, childState.pr!.headSha, {
      buildSlug: child.slug,
    })
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    expect(ofType(await h.events(node.slug), 'integration.prepared')).toHaveLength(1)
    await h.runLatest()
    await h.dispatcher.tick()
    const verified = reduceBuild(await h.events(node.slug))
    expect(verified.verify.results.some((result) => result.outcome === 'pass')).toBe(true)
    expect(ofType(await h.events(node.slug), 'plan.started')).toHaveLength(0)
    expect(ofType(await h.events(node.slug), 'finalize.started')).toHaveLength(0)
    expect(verified.status).not.toBe('done')
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: node.slug,
      action: { kind: 'land' },
      ticketSource: async () => h.tickets,
    })
    h.clock.advance(180_000)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const landed = reduceBuild(await h.events(node.slug))
    expect(landed.integration?.landing).toMatchObject({
      provenance: 'kernel',
      verified: true,
      fenced: true,
    })
    expect(landed.status).toBe('done')
    expect((await h.tickets.get('NODE'))?.resolved).toBe(true)
    const { git } = await import('./harness')
    expect(await git(['show', '-s', '--format=%B', 'main'], h.origin)).toContain(
      `Autobuild-Build: ${child.slug}`,
    )
    expect(await git(['show', '-s', '--format=%B', 'main'], h.origin)).not.toContain(
      `Autobuild-Build: ${node.slug}`,
    )
  } finally {
    await h.cleanup()
  }
})

test('operator revision retries failed node verification on the same head without restarting children', async () => {
  let nodeSlug = ''
  let nodeContexts = 0
  const h = await makeHarness({
    localGitForge: true,
    configToml: CONFIG_TOML.replace('steps = ["unit"]', 'steps = ["unit", "spec-check"]').replace(
      '[policy]',
      '[verify.spec-check]\nkind = "agent"\nskill = "spec-check"\n\n[policy]',
    ),
    handlers: {
      ...happyHandlers(),
      'spec-check': async (cli) => {
        await cli.run(['context'])
        if (cli.env.build === nodeSlug) {
          expect(await Bun.file(`${cli.ws}/${cli.env.contextDir}/spec.md`).text()).toBe(replacement)
          nodeContexts++
        }
        await cli.run(['verdict', 'pass'])
      },
    },
    tickets: [
      { ...readyTicket('NODE', { title: 'Revision node' }), kind: 'node' },
      { ...readyTicket('CHILD', { title: 'Revision child' }), target: 'NODE' },
    ],
  })
  const replacement =
    '# Revised node\n\n## Acceptance criteria\n- Works.\n\n## Out of scope\n- Other work.\n'
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'NODE')!
    nodeSlug = node.slug
    // Incomplete nodes remain idle after an explicit revision.
    const revise = () =>
      controlBuild({
        store: h.store,
        repo: h.origin,
        slug: node.slug,
        action: {
          kind: 'answer',
          resolve: {
            kind: 'revise-spec',
            body: { kind: 'supplied', origin: 'replacement.md', read: async () => replacement },
          },
        },
      })
    await revise()
    expect(reduceBuild(await h.events(node.slug)).status).toBe('collecting')
    expect(ofType(await h.events(node.slug), 'integration.prepared')).toHaveLength(0)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    await h.runLatest()
    const child = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'CHILD')!
    const childState = reduceBuild(await h.events(child.slug))
    await h.forgeAdapter.squashMerge(h.origin, childState.pr!.number, childState.pr!.headSha, {
      buildSlug: child.slug,
    })
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    await h.runLatest()
    const verified = reduceBuild(await h.events(node.slug))
    const cycle = verified.integration!.cycle!
    // A failed receipt parks this exact cycle, independently of head movement.
    await h.store.append(node.slug, {
      actor: { kind: 'kernel' },
      type: 'verify.completed',
      payload: {
        step: 'unit',
        attempt: 2,
        outcome: 'fail',
        restackId: cycle.id,
        headSha: cycle.head,
        baseSha: cycle.parent,
      },
    })
    expect(reduceBuild(await h.events(node.slug)).status).toBe('blocked')
    const childEvents = await h.events(child.slug)
    const contributions = ofType(await h.events(node.slug), 'node.contribution-recorded')
    await revise()
    expect(reduceBuild(await h.events(node.slug)).status).toBe('collecting')
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const prepared = ofType(await h.events(node.slug), 'integration.prepared')
    expect(prepared).toHaveLength(2)
    expect(prepared[1]!.payload).toMatchObject({ head: cycle.head, parent: cycle.parent })
    expect(prepared[1]!.payload.id).not.toBe(cycle.id)
    await h.runLatest()
    expect(nodeContexts).toBe(2)
    const after = reduceBuild(await h.events(node.slug))
    expect(
      after.verify.results.some(
        (r) => r.restackId === prepared[1]!.payload.id && r.outcome === 'pass',
      ),
    ).toBe(true)
    expect(await h.events(child.slug)).toEqual(childEvents)
    expect(ofType(await h.events(node.slug), 'node.contribution-recorded')).toEqual(contributions)
    expect(ofType(await h.events(node.slug), 'plan.started')).toHaveLength(0)
    const artifact = await h.store.getArtifact(node.slug, 'spec', after.specRev)
    expect(new TextDecoder().decode(artifact!.content)).toBe(replacement)
  } finally {
    await h.cleanup()
  }
})

for (const mode of ['success', 'bare', 'cas', 'lease', 'missing', 'check-only'] as const) {
  test(`dispatcher prepares node inputs with ${mode}`, async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const manifests: { build: string; specs: string[] }[] = []
    const h = await makeHarness({
      localGitForge: true,
      configToml:
        mode === 'check-only'
          ? CONFIG_TOML
          : CONFIG_TOML.replace('steps = ["unit"]', 'steps = ["unit", "visual"]') +
            '\n[verify.visual]\nkind = "agent"\nskill = "visual"\n',
      handlers: {
        ...happyHandlers(),
        visual: async (cli) => {
          await cli.run(['context'])
          const manifest = JSON.parse(
            await readFile(join(cli.ws, '.ab/verify-visual/context.json'), 'utf8'),
          )
          if (manifest.nodeVerification) {
            const specs = await Promise.all(
              manifest.nodeVerification.contributions.map((c: { specPath: string }) =>
                readFile(join(cli.ws, c.specPath), 'utf8'),
              ),
            )
            manifests.push({ build: cli.env.build!, specs })
          }
          await cli.run(['verdict', 'pass'])
        },
      },
      tickets: [
        { ...readyTicket('NODE', { title: 'Integration node' }), kind: 'node' },
        { ...readyTicket('CHILD', { title: 'Child change' }), target: 'NODE' },
      ],
    })
    try {
      await h.dispatcher.tick()
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      const node = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'NODE')!
      const child = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'CHILD')!
      await h.runLatest()
      const childState = reduceBuild(await h.events(child.slug))
      await h.forgeAdapter.squashMerge(h.origin, childState.pr!.number, childState.pr!.headSha, {
        buildSlug: child.slug,
      })
      if (mode === 'lease') h.store.renewNodeWriter = async () => false
      if (mode === 'cas') h.store.appendWithArtifactsIfCurrent = async () => null
      if (mode === 'missing') {
        const get = h.store.getArtifact.bind(h.store)
        h.store.getArtifact = async (slug, kind, rev) =>
          slug === child.slug && kind === 'spec' ? null : get(slug, kind, rev)
      }
      let preparation = h.dispatcher
      if (mode === 'bare') {
        await Bun.$`git -C ${h.origin} remote add origin ${h.origin}`.quiet()
        const { Dispatcher } = await import('../processes/dispatcher')
        const { gitRewrite } = await import('../ports/forge/git-rewrite')
        const { spawnExec } = await import('../ports/workspace/git-worktree')
        const transport = gitRewrite(spawnExec, false)
        const forge = new Proxy(h.forgeAdapter, {
          get(target, key) {
            if (key === 'kernelRewrite' || key === 'rewrite') return transport
            if (key === 'kernelExec') return spawnExec
            if (key === 'openPr')
              return (input: Parameters<typeof target.openPr>[0]) =>
                target.openPr({ ...input, workspacePath: h.origin })
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        preparation = new Dispatcher({
          store: h.store,
          tickets: h.tickets,
          workspaces: h.workspaces,
          forge,
          config: h.config,
          repo: h.origin,
          repoOrigin: h.origin,
          exec: spawnExec,
          ids: h.ids,
          clock: h.clock,
          launchRunner: async () => 'scheduled',
        })
      }
      await preparation.tick()
      await preparation.tick()
      if (mode === 'cas' || mode === 'lease' || mode === 'missing') {
        expect(ofType(await h.events(node.slug), 'integration.prepared')).toHaveLength(0)
        expect(await h.store.listArtifacts(node.slug, 'node-verification-context')).toHaveLength(0)
        expect(h.launched.some((entry) => entry.slug === node.slug)).toBe(false)
        return
      }
      const cycle = reduceBuild(await h.events(node.slug)).integration!.cycle!
      if (mode === 'check-only') {
        expect(cycle.context).toBeUndefined()
        expect(await h.store.listArtifacts(node.slug, 'node-verification-context')).toHaveLength(0)
        return
      }
      expect(cycle.context?.kind).toBe('node-verification-context')
      const input = await h.store.getArtifact(node.slug, cycle.context!.kind, cycle.context!.rev)
      const frozen = JSON.parse(new TextDecoder().decode(input!.content))
      expect(frozen.cycle).toBe(cycle.id)
      expect(frozen.index.contributions.map((c: { build: string }) => c.build)).toContain(
        child.slug,
      )
      if (mode === 'bare') return
      await h.store.putArtifact(child.slug, { kind: 'spec', content: 'later unsanctioned deposit' })
      await h.runLatest()
      expect(manifests).toEqual([{ build: node.slug, specs: [frozen.specs[child.slug]] }])
    } finally {
      await h.cleanup()
    }
  })
}

test('paused child crosses two durable kernel rewrites before its next demand', async () => {
  const { git, commitAll } = await import('./harness')
  const { join } = await import('node:path')
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('A', { title: 'Parent node' }), kind: 'node' },
      { ...readyTicket('B', { title: 'Paused child' }), kind: 'node', target: 'A' },
    ],
  })
  const tick = async () => {
    for (let i = 0; i < 4; i++) await h.dispatcher.tick()
  }
  try {
    await tick()
    const nodes = await h.store.listBuilds()
    const a = nodes.find((r) => r.ticket?.id === 'A')!
    const b = nodes.find((r) => r.ticket?.id === 'B')!
    for (const [node, file] of [
      [a, 'parent-owned'],
      [b, 'child-owned'],
    ] as const) {
      const ws = join(h.tmp, file)
      await git(['worktree', 'add', ws, node.branch!], h.origin)
      await Bun.write(join(ws, file), file)
      await commitAll(ws, file)
      await git(['worktree', 'remove', ws], h.origin)
    }
    await tick()
    await requestNodeRestack({ store: h.store, repo: h.origin, slug: b.slug, user: 'operator' })
    await tick()
    const baseline = reduceBuild(await h.events(b.slug)).nodeRestack!.contributionBase!
    await controlBuild({ store: h.store, repo: h.origin, slug: b.slug, action: { kind: 'pause' } })
    await tick()
    for (const round of [1, 2]) {
      await Bun.write(join(h.origin, `root-${round}`), `root ${round}`)
      await commitAll(h.origin, `root ${round}`)
      await requestNodeRestack({ store: h.store, repo: h.origin, slug: a.slug, user: 'operator' })
      await tick()
      if (round === 1) {
        const ws = join(h.tmp, 'sibling-landing')
        await git(['worktree', 'add', ws, a.branch!], h.origin)
        await Bun.write(join(ws, 'sibling-owned'), 'sibling-owned')
        await commitAll(ws, 'sibling lands between parent restacks')
        await git(['worktree', 'remove', ws], h.origin)
        await tick()
      }
    }
    const parentHead = await git(['rev-parse', a.branch!], h.origin)
    expect(ofType(await h.events(a.slug), 'node.rewritten')).toHaveLength(2)
    await controlBuild({ store: h.store, repo: h.origin, slug: b.slug, action: { kind: 'resume' } })
    await tick()
    await requestNodeRestack({ store: h.store, repo: h.origin, slug: b.slug, user: 'operator' })
    await tick()
    const state = reduceBuild(await h.events(b.slug))
    expect(state.targetRewrite).toBeUndefined()
    expect(state.nodeRestack?.contributionBase).toBe(parentHead)
    const move = ofType(await h.events(b.slug), 'target.moved').find(
      (e) => e.payload.sha === parentHead,
    )!
    expect(move.payload.lineage?.find((p) => p.from === baseline)?.receipts).toHaveLength(2)
    for (const file of ['parent-owned', 'child-owned', 'sibling-owned', 'root-1', 'root-2'])
      expect(await git(['show', `${b.branch}:${file}`], h.origin)).toBe(
        file.startsWith('root-') ? file.replace('-', ' ') : file,
      )
    expect(h.launched).toHaveLength(0)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('leaf verify entry uses recorded kernel lineage after its parent restacks during implement', async () => {
  const { git, commitAll } = await import('./harness')
  const { join } = await import('node:path')
  const happy = happyHandlers()
  let parentSlug = ''
  let parentBranch = ''
  const h = await makeHarness({
    localGitForge: true,
    handlers: {
      ...happy,
      implement: async (cli) => {
        await happy.implement!({
          ...cli,
          run: async (argv) => {
            if (argv[0] === 'done') {
              for (const round of [1, 2]) {
                await Bun.write(join(h.origin, 'new-root'), `new root ${round}`)
                await commitAll(h.origin, `advance root ${round} while leaf implements`)
                await requestNodeRestack({
                  store: h.store,
                  repo: h.origin,
                  slug: parentSlug,
                  user: 'operator',
                })
                for (let i = 0; i < 4; i++) await h.dispatcher.tick()
                if (round === 1) {
                  const ws = join(h.tmp, 'sibling-landing')
                  await git(['worktree', 'add', ws, parentBranch], h.origin)
                  await Bun.write(join(ws, 'sibling-owned'), 'sibling')
                  await commitAll(ws, 'sibling lands while leaf implements')
                  await git(['worktree', 'remove', ws], h.origin)
                  for (let i = 0; i < 4; i++) await h.dispatcher.tick()
                }
              }
            }
            return cli.run(argv)
          },
        })
      },
    },
    tickets: [
      { ...readyTicket('NODE', { title: 'Moving parent' }), kind: 'node' },
      { ...readyTicket('LEAF', { title: 'Implementing child' }), target: 'NODE' },
    ],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'NODE')!
    parentSlug = node.slug
    parentBranch = node.branch!
    const ws = join(h.tmp, 'parent-owned')
    await git(['worktree', 'add', ws, parentBranch], h.origin)
    await Bun.write(join(ws, 'parent-owned'), 'owned')
    await commitAll(ws, 'parent owned contribution')
    await git(['worktree', 'remove', ws], h.origin)
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    const child = (await h.store.listBuilds()).find((r) => r.ticket?.id === 'LEAF')!
    await h.runLatest()
    const events = await h.events(child.slug)
    expect(reduceBuild(events).targetRewrite).toBeUndefined()
    expect(reduceBuild(events).pr).toBeDefined()
    expect(ofType(events, 'target.moved').some((e) => e.payload.lineage?.length)).toBe(true)
    expect(ofType(events, 'restack.completed').at(-1)?.payload.targetBase).toBe(
      await git(['rev-parse', parentBranch], h.origin),
    )
    const head = reduceBuild(events).pr!.headSha
    expect(await git(['show', `${head}:parent-owned`], h.origin)).toBe('owned')
    expect(await git(['show', `${head}:new-root`], h.origin)).toBe('new root 2')
    expect(await git(['show', `${head}:sibling-owned`], h.origin)).toBe('sibling')
    expect(h.cliErrors).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 30_000)
