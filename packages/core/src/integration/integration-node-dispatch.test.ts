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
    h.clock.advance(60_000)
    const report = await h.dispatcher.tick()
    expect(report.dependencyDiagnostics.join(' ')).toContain('closed')
    expect((await h.store.listBuilds()).some((r) => r.ticket?.id === 'CHILD')).toBe(false)
    expect(h.launched.every((r) => r.slug !== node.slug)).toBe(true)
  } finally {
    await h.cleanup()
  }
})
