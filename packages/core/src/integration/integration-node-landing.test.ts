import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { makeHarness, happyHandlers, readyTicket, git, commitAll } from './harness'
import { controlBuild } from '../cli/build-control'
import { reduceBuild } from '../kernel/reducer'
import { observeIntegration } from '../kernel/integration-completeness'
import { integrationHeadVerified } from '../kernel/integration-state'

async function addStack(h: Awaited<ReturnType<typeof makeHarness>>, branch: string) {
  const cwd = join(h.tmp, 'stack')
  await git(['worktree', 'add', cwd, branch], h.origin)
  for (const id of ['first-child', 'second-child']) {
    await Bun.write(join(cwd, id), id)
    await Bun.write(join(cwd, 'ok.marker'), 'ok')
    await commitAll(cwd, `Change ${id}\n\nAutobuild-Build: ${id}`)
  }
  await git(['worktree', 'remove', cwd], h.origin)
}

test('nested node landing preserves both child commits and parent lands the stack without wrappers', async () => {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('A', { title: 'Parent integration' }), kind: 'node' },
      { ...readyTicket('B', { title: 'Nested integration' }), kind: 'node', target: 'A' },
    ],
  })
  try {
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const records = await h.store.listBuilds()
    const a = records.find((record) => record.ticket?.id === 'A')!
    const b = records.find((record) => record.ticket?.id === 'B')!
    await addStack(h, b.branch!)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    await h.runLatest()
    const state = reduceBuild(await h.events(b.slug))
    expect(integrationHeadVerified(state, state.integration!.cycle!.head)).toBe(true)
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: b.slug,
      action: { kind: 'auto-merge-on' },
      ticketSource: async () => h.tickets,
    })
    for (let i = 0; i < 4; i++) {
      h.clock.advance(60_000)
      await h.dispatcher.tick()
    }
    expect(reduceBuild(await h.events(b.slug)).status).toBe('done')
    await h.runLatest()
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: a.slug,
      action: { kind: 'auto-merge-on' },
      ticketSource: async () => h.tickets,
    })
    for (let i = 0; i < 4; i++) {
      h.clock.advance(60_000)
      await h.dispatcher.tick()
    }
    expect(reduceBuild(await h.events(a.slug)).status).toBe('done')
    const messages = await git(['log', '-2', '--format=%B', 'main'], h.origin)
    expect(messages).toContain('Autobuild-Build: first-child')
    expect(messages).toContain('Autobuild-Build: second-child')
    expect(messages).not.toContain(`Autobuild-Build: ${a.slug}`)
    expect(messages).not.toContain(`Autobuild-Build: ${b.slug}`)
    expect(await git(['rev-list', '--merges', 'main'], h.origin)).toBe('')
  } finally {
    await h.cleanup()
  }
})

test('native terminal states, partial listings and reopening govern completeness', async () => {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('NODE', { title: 'Release integration' }), kind: 'node' },
      { ...readyTicket('TRIAGE', { title: 'Unfinished child' }), target: 'NODE', state: 'Triage' },
    ],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    expect((await observeIntegration(h.store, h.tickets, node.slug)).openChildren).toEqual([
      'TRIAGE',
    ])
    await h.tickets.transition('TRIAGE', 'Done')
    expect((await observeIntegration(h.store, h.tickets, node.slug)).openChildren).toEqual([])
    await expect(
      controlBuild({
        store: h.store,
        repo: h.origin,
        slug: node.slug,
        action: { kind: 'auto-merge-on' },
        ticketSource: async () => h.tickets,
      }),
    ).rejects.toThrow('no landed changes')
    await h.tickets.transition('TRIAGE', 'Ready')
    expect((await observeIntegration(h.store, h.tickets, node.slug)).openChildren).toEqual([
      'TRIAGE',
    ])
    const broken: import('../ports/types').TicketSource = Object.create(h.tickets)
    broken.listAll = async () => {
      throw new Error('listing unavailable')
    }
    const observed = await observeIntegration(h.store, broken, node.slug)
    expect(observed.diagnostics).toEqual(['listing unavailable'])
  } finally {
    await h.cleanup()
  }
})

test('a verification-blocked node admits a repair child and verifies the repaired head', async () => {
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [{ ...readyTicket('NODE', { title: 'Repairable integration' }), kind: 'node' }],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    const cwd = join(h.tmp, 'broken')
    await git(['worktree', 'add', cwd, node.branch!], h.origin)
    await Bun.write(join(cwd, 'broken.txt'), 'missing marker')
    await commitAll(cwd, 'Broken contribution\n\nAutobuild-Build: broken-child')
    await git(['worktree', 'remove', cwd], h.origin)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    await h.runLatest()
    expect(reduceBuild(await h.events(node.slug)).status).toBe('blocked')
    h.tickets.add({ ...readyTicket('REPAIR', { title: 'Repair missing marker' }), target: 'NODE' })
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    await h.runLatest()
    const repair = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'REPAIR')!
    expect(repair).toBeDefined()
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: repair.slug,
      action: { kind: 'auto-merge-on' },
    })
    for (let i = 0; i < 4; i++) {
      h.clock.advance(60_000)
      await h.dispatcher.tick()
    }
    expect(reduceBuild(await h.events(repair.slug)).status).toBe('done')
    await h.runLatest()
    const repaired = reduceBuild(await h.events(node.slug))
    expect(repaired.status).not.toBe('blocked')
    expect(repaired.integration?.cycles).toHaveLength(2)
    expect(integrationHeadVerified(repaired, repaired.integration!.cycle!.head)).toBe(true)
    expect(repaired.verify.results.filter((result) => result.outcome === 'fail')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
})

test('an unfenced tree mismatch raises durable attention after completion and audits once', async () => {
  const { auditIntegrationLanding } = await import('../kernel/integration-landing')
  const { spawnExec } = await import('../ports/workspace/git-worktree')
  const { KERNEL, DISPATCHER } = await import('../events/envelope')
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [{ ...readyTicket('NODE', { title: 'Audited integration' }), kind: 'node' }],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    const parent = await git(['rev-parse', 'main'], h.origin)
    await addStack(h, node.branch!)
    const head = await git(['rev-parse', node.branch!], h.origin)
    await Bun.write(join(h.origin, 'raced-parent.txt'), 'unverified concurrent parent')
    const landed = await commitAll(h.origin, 'Concurrent shared parent')
    await h.store.append(node.slug, {
      actor: KERNEL,
      type: 'integration.landing-intended',
      payload: {
        id: 'audit-op',
        cycle: 'audit-cycle',
        head,
        parent,
        commandSeq: 1,
        fenced: false,
        evidence: ['unfenced fixture'],
      },
    })
    await h.store.append(node.slug, {
      actor: DISPATCHER,
      type: 'integration.landed',
      payload: {
        operation: 'audit-op',
        head,
        landed,
        provenance: 'kernel',
        verified: true,
        fenced: false,
      },
    })
    await h.store.append(node.slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    const deps = {
      store: h.store,
      forge: h.forgeAdapter,
      exec: spawnExec,
      workspacePath: h.origin,
      slug: node.slug,
      id: 'audit-attention',
    }
    await auditIntegrationLanding(deps)
    await auditIntegrationLanding(deps)
    const state = reduceBuild(await h.events(node.slug))
    expect(state.status).toBe('done')
    expect(state.integration?.audit?.verifiedTree).not.toBe(state.integration?.audit?.landedTree)
    expect(state.openEscalations).toHaveLength(1)
    expect(state.openEscalations[0]!.question).toContain('requires attention')
    expect(await git(['rev-parse', 'main'], h.origin)).toBe(landed)
  } finally {
    await h.cleanup()
  }
})

test('prepared cycles consume capacity only when execution resources are admitted', async () => {
  const { CONFIG_TOML } = await import('./harness')
  const h = await makeHarness({
    localGitForge: true,
    configToml: CONFIG_TOML.replace('capacity = 2', 'capacity = 1'),
    handlers: happyHandlers(),
    tickets: [
      readyTicket('BUSY', { title: 'Existing work' }),
      { ...readyTicket('A', { title: 'Waiting integration alpha' }), kind: 'node' },
      { ...readyTicket('B', { title: 'Waiting integration beta' }), kind: 'node' },
    ],
  })
  try {
    await h.dispatcher.tick()
    const records = await h.store.listBuilds()
    const nodes = records.filter((record) => record.branch?.startsWith('ab-node/'))
    for (const node of nodes) await addStack(h, node.branch!)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    expect(
      h.launched.filter((entry) => nodes.some((node) => node.slug === entry.slug)),
    ).toHaveLength(0)
    const busy = records.find((record) => record.ticket?.id === 'BUSY')!
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: busy.slug,
      action: { kind: 'abort' },
    })
    await h.runLatest()
    h.clock.advance(180_000)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    await h.runLatest()
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    await h.runLatest()
    for (const node of nodes) {
      const state = reduceBuild(await h.events(node.slug))
      expect(integrationHeadVerified(state, state.integration!.cycle!.head)).toBe(true)
    }
  } finally {
    await h.cleanup()
  }
})

test('integration agent verification receives exact commit range without producer artifacts', async () => {
  const { CONFIG_TOML } = await import('./harness')
  const handlers = happyHandlers()
  let verified = 0
  handlers['ab-verify-feature'] = async (cli) => {
    await cli.run(['context'])
    const manifest = await Bun.file(join(cli.ws, '.ab/context.json')).json()
    expect(manifest.commitRange.base).toBeTruthy()
    expect(manifest.commitRange.head).toBe(await git(['rev-parse', 'HEAD'], cli.ws))
    expect(manifest.materialized['plan.md']).toBeUndefined()
    expect(manifest.materialized['implement-notes.md']).toBeUndefined()
    verified++
    await cli.run(['verdict', 'pass'])
  }
  const h = await makeHarness({
    localGitForge: true,
    handlers,
    configToml:
      CONFIG_TOML.replace('steps = ["unit"]', 'steps = ["unit", "feature"]') +
      '\n[verify.feature]\nkind = "agent"\nskill = "ab-verify-feature"\n',
    tickets: [{ ...readyTicket('NODE', { title: 'Agent verified integration' }), kind: 'node' }],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    await addStack(h, node.branch!)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    await h.runLatest()
    expect(verified).toBe(1)
    const state = reduceBuild(await h.events(node.slug))
    expect(integrationHeadVerified(state, state.integration!.cycle!.head)).toBe(true)
  } finally {
    await h.cleanup()
  }
})
