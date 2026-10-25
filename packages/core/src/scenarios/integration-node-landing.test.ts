import { DISPATCHER } from '../events/envelope'
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { makeHarness, happyHandlers, readyTicket, git, commitAll, CONFIG_TOML } from './harness'
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

async function seedContributors(h: Awaited<ReturnType<typeof makeHarness>>, repo: string) {
  for (const slug of ['first-child', 'second-child']) {
    const ticket = { source: 'fake', id: slug }
    await h.store.createBuild({ slug, repo, ticket })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo, baseBranch: 'main' },
    })
    await h.store.putArtifact(slug, { kind: 'spec', content: `Authorize ${slug}` })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'spec.imported',
      payload: { ticket, artifact: { kind: 'spec', rev: 0 } },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }
}

test('nested node merge preserves both child commits and parent merges the stack without wrappers', async () => {
  const h = await makeHarness({
    localGitForge: true,
    configToml: `${CONFIG_TOML}\n[[merge]]\nfrom = "leaf"\nmode = "consent"\n`,
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
    await h.dispatcher.tick()
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: b.slug,
      action: { kind: 'land' },
      ticketSource: async () => h.tickets,
    })
    for (let i = 0; i < 4; i++) {
      h.clock.advance(60_000)
      await h.dispatcher.tick()
    }
    expect(reduceBuild(await h.events(b.slug)).status).toBe('done')
    await h.runLatest()
    await h.dispatcher.tick()
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: a.slug,
      action: { kind: 'land' },
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
    configToml: `${CONFIG_TOML}\n[[merge]]\nfrom = "leaf"\nmode = "consent"\n`,
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
        action: { kind: 'land' },
        ticketSource: async () => h.tickets,
      }),
    ).rejects.toThrow('Merge is not ready')
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
    configToml: `${CONFIG_TOML}\n[[merge]]\nfrom = "leaf"\nmode = "consent"\n`,
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
    const failures = (await h.events(node.slug)).filter(
      (event) => event.type === 'integration.verification-failed',
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]!.payload).toMatchObject({
      steps: ['unit'],
      guidance: `file a repair child targeting this node: ${node.slug}`,
    })
    await h.dispatcher.tick()
    expect(
      (await h.events(node.slug)).filter(
        (event) => event.type === 'integration.verification-failed',
      ),
    ).toHaveLength(1)
    h.tickets.add({ ...readyTicket('REPAIR', { title: 'Repair missing marker' }), target: 'NODE' })
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    await h.runLatest()
    const repair = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'REPAIR')!
    expect(repair).toBeDefined()
    await h.dispatcher.tick()
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: repair.slug,
      action: { kind: 'land' },
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
      type: 'pr.opened',
      payload: { pr: { number: 1, url: 'https://forge/pr/1', headSha: head } },
    })
    await h.store.append(node.slug, {
      actor: KERNEL,
      type: 'landing.native-applied',
      payload: { enabled: false, operation: 'node-restack' },
    })
    // Terminal audit work must not re-enter PR settlement or probe the forge.
    h.forgeAdapter.getPrState = async () => {
      throw new Error('terminal PR must not be reprobed')
    }
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
    expect(
      (await h.store.getRepoBuildDigests(h.origin)).get(node.slug)?.integrationAuditPending,
    ).toBe(true)
    await h.dispatcher.tick()
    expect(reduceBuild(await h.events(node.slug)).integration?.audit).toBeDefined()
    expect(
      (await h.store.getRepoBuildDigests(h.origin)).get(node.slug)?.integrationAuditPending,
    ).toBeUndefined()
    await h.dispatcher.tick()
    expect((await h.events(node.slug)).filter((e) => e.type === 'build.completed')).toHaveLength(1)
    expect(
      (await h.events(node.slug)).filter((e) => e.type === 'integration.audited'),
    ).toHaveLength(1)
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
    const manifest = await Bun.file(join(cli.ws, cli.env.contextDir!, 'context.json')).json()
    expect(manifest.commitRange.base).toBeTruthy()
    expect(manifest.commitRange.head).toBe(await git(['rev-parse', 'HEAD'], cli.ws))
    expect(
      manifest.nodeVerification.contributions.map((entry: { build: string }) => entry.build),
    ).toEqual(['first-child', 'second-child'])
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
    await seedContributors(h, node.repo)
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

test.each([false, true])(
  'recorded migration preserves nested merge and ticket cleanup (remap=%s)',
  async (remap) => {
    const h = await makeHarness({
      localGitForge: true,
      configToml: `${CONFIG_TOML}\n[[merge]]\nfrom = "leaf"\nmode = "consent"\n`,
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
      const { FakeTicketSource } = await import('../ports/tickets/fake')
      const { Dispatcher } = await import('../processes/dispatcher')
      const { recordTicketMigration } = await import('../kernel/ticket-migrations')
      const mapping = { A: remap ? 'NEW-A' : 'A', B: remap ? 'NEW-B' : 'B' }
      const destination = new FakeTicketSource(
        (await h.tickets.listAll()).tickets.map((ticket) => ({
          ...ticket,
          ref: { ...ticket.ref, source: 'file', id: mapping[ticket.ref.id as 'A' | 'B'] },
          target: ticket.target ? mapping[ticket.target as 'A' | 'B'] : undefined,
        })),
      )
      Object.defineProperty(destination, 'name', { value: 'file' })
      await h.store.ensureRepo(h.origin)
      await recordTicketMigration(
        h.store,
        h.origin,
        { kind: 'human', user: 'operator' },
        { identity: 'cutover', from: 'fake', to: 'file', mapping },
      )
      h.dispatcher = new Dispatcher({
        ...(h.dispatcher as unknown as { deps: import('../processes/dispatcher').DispatcherDeps })
          .deps,
        tickets: destination,
      })

      await addStack(h, b.branch!)
      for (let i = 0; i < 3; i++) await h.dispatcher.tick()
      await h.runLatest()
      const state = reduceBuild(await h.events(b.slug))
      expect(integrationHeadVerified(state, state.integration!.cycle!.head)).toBe(true)
      await h.dispatcher.tick()
      await controlBuild({
        store: h.store,
        repo: h.origin,
        slug: b.slug,
        action: { kind: 'land' },
        ticketSource: async () => destination,
      })
      for (let i = 0; i < 4; i++) {
        h.clock.advance(60_000)
        await h.dispatcher.tick()
      }
      expect(reduceBuild(await h.events(b.slug)).status).toBe('done')
      await h.runLatest()
      await h.dispatcher.tick()
      await controlBuild({
        store: h.store,
        repo: h.origin,
        slug: a.slug,
        action: { kind: 'land' },
        ticketSource: async () => destination,
      })
      for (let i = 0; i < 4; i++) {
        h.clock.advance(60_000)
        await h.dispatcher.tick()
      }
      expect(reduceBuild(await h.events(a.slug)).status).toBe('done')
      expect(destination.transitions).toEqual(
        expect.arrayContaining([
          { id: mapping.A, state: 'Done' },
          { id: mapping.B, state: 'Done' },
        ]),
      )
      expect(
        destination.comments.some(
          (notice) => notice.id === mapping.A && notice.body.includes('merged'),
        ),
      ).toBe(true)
      expect((await h.store.getBuild(a.slug))?.ticket?.source).toBe('fake')
      expect(reduceBuild(await h.events(b.slug)).landing?.decision?.into).toEqual({
        kind: 'node',
        ticket: mapping.A,
      })

      const messages = await git(['log', '-2', '--format=%B', 'main'], h.origin)
      expect(messages).toContain('Autobuild-Build: first-child')
      expect(messages).toContain('Autobuild-Build: second-child')
      expect(messages).not.toContain(`Autobuild-Build: ${a.slug}`)
      expect(messages).not.toContain(`Autobuild-Build: ${b.slug}`)
      expect(await git(['rev-list', '--merges', 'main'], h.origin)).toBe('')
    } finally {
      await h.cleanup()
    }
  },
)

test('dispatcher recovers a failed receipt without a runner, workspace or successful forge read', async () => {
  const { KERNEL, DISPATCHER } = await import('../events/envelope')
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [{ ...readyTicket('NODE', { title: 'Recover failed verification' }), kind: 'node' }],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    const head = 'a'.repeat(40)
    const parent = 'b'.repeat(40)
    await h.store.append(node.slug, {
      actor: DISPATCHER,
      type: 'node.compared',
      payload: { headSha: head, parentSha: parent, ahead: 1 },
    })
    await h.store.append(node.slug, {
      actor: DISPATCHER,
      type: 'integration.prepared',
      payload: { id: 'crashed-cycle', head, parent, config: '{"verify":{"steps":["unit"]}}' },
    })
    await h.store.append(node.slug, {
      actor: KERNEL,
      type: 'verify.completed',
      payload: {
        step: 'unit',
        attempt: 1,
        outcome: 'fail',
        restackId: 'crashed-cycle',
        headSha: head,
        baseSha: parent,
      },
    })
    const launches = h.launched.length
    // Every forge operation may fail: reporting must happen before any probe.
    h.forge.getPrState = async () => {
      throw new Error('forge unavailable')
    }
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const events = await h.events(node.slug)
    expect(events.filter((event) => event.type === 'integration.verification-failed')).toHaveLength(
      1,
    )
    expect(events.filter((event) => event.type === 'verify.started')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'escalation.raised')).toHaveLength(0)
    expect(h.launched).toHaveLength(launches)
    const { readBuildFacts } = await import('../store/reduced-reads')
    expect((await readBuildFacts(h.store, node.slug)).value.workspace).toBeNull()
  } finally {
    await h.cleanup()
  }
})

test('agent verification failure reports the exact node cycle once without an escalation', async () => {
  let verdictSubmitted = false
  let handPushedSha = ''
  const message =
    'Document integration repair intent\n\nExercise agent failure with hand-pushed changes.'
  const handlers = happyHandlers()
  handlers['ab-verify-feature'] = async (cli) => {
    await cli.run(['context'])
    const manifest = await Bun.file(join(cli.ws, cli.env.contextDir!, 'context.json')).json()
    const cycle = reduceBuild(await h.events(cli.env.build)).integration!.cycle!
    expect(manifest.commitRange).toEqual({ base: cycle.parent, head: cycle.head })
    expect(manifest.commitRange.head).toBe(await git(['rev-parse', 'HEAD'], cli.ws))
    const provenance = manifest.nodeVerification
    expect(provenance.range).toEqual(manifest.commitRange)
    expect(provenance.contributions.map((entry: { build: string }) => entry.build)).toEqual([
      'first-child',
      'second-child',
    ])
    for (const contribution of provenance.contributions) {
      expect(contribution.ticket).toEqual({ source: 'fake', id: contribution.build })
      expect(contribution.spec).toEqual({ kind: 'spec', rev: 0 })
      expect(await Bun.file(join(cli.ws, contribution.specPath)).text()).toBe(
        `Authorize ${contribution.build}`,
      )
      expect(
        manifest.materialized[contribution.specPath.slice(manifest.contextDir.length + 1)],
      ).toBe('derived')
    }
    const index = await Bun.file(join(cli.ws, provenance.indexPath)).json()
    expect(index.contributions).toEqual(provenance.contributions)
    const intent = [{ sha: handPushedSha, originalSha: handPushedSha, message: `${message}\n` }]
    expect(provenance.handPushedCommits).toEqual(intent)
    expect(index.handPushedCommits).toEqual(intent)
    expect(index.unattributedCommits).toEqual([handPushedSha])
    const report = join(cli.ws, '.ab/feature-report.md')
    await Bun.write(report, 'Feature verification failed: repair the integration.')
    await cli.run(['verdict', 'fail', '--report', report])
    verdictSubmitted = true
  }
  const h = await makeHarness({
    localGitForge: true,
    handlers,
    configToml:
      CONFIG_TOML.replace('steps = ["unit"]', 'steps = ["unit", "feature"]') +
      '\n[verify.feature]\nkind = "agent"\nskill = "ab-verify-feature"\n',
    tickets: [{ ...readyTicket('NODE', { title: 'Agent failed integration' }), kind: 'node' }],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds())[0]!
    await seedContributors(h, node.repo)
    await addStack(h, node.branch!)
    const cwd = join(h.tmp, 'hand-pushed')
    await git(['worktree', 'add', cwd, node.branch!], h.origin)
    try {
      await Bun.write(join(cwd, 'repair-intent.txt'), 'Review the integrated feature before merge.')
      handPushedSha = await commitAll(cwd, message)
    } finally {
      await git(['worktree', 'remove', cwd], h.origin)
    }
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    await h.runLatest()
    await h.dispatcher.tick()
    const events = await h.events(node.slug)
    const state = reduceBuild(events)
    expect(verdictSubmitted).toBe(true)
    expect(h.cliErrors).toEqual([])
    const cycle = state.integration!.cycle!
    expect(state.verify.results).toEqual(
      expect.arrayContaining(
        ['unit', 'feature'].map((step) =>
          expect.objectContaining({
            step,
            outcome: step === 'unit' ? 'pass' : 'fail',
            restackId: cycle.id,
            headSha: cycle.head,
            baseSha: cycle.parent,
          }),
        ),
      ),
    )
    expect(state.status).toBe('blocked')
    const reports = events.filter((event) => event.type === 'integration.verification-failed')
    expect(reports).toHaveLength(1)
    expect(reports[0]!.payload).toMatchObject({
      id: state.integration!.cycle!.id,
      head: state.integration!.cycle!.head,
      parent: state.integration!.cycle!.parent,
      steps: ['feature'],
      guidance: `file a repair child targeting this node: ${node.slug}`,
    })
    expect(events.filter((event) => event.type === 'escalation.raised')).toHaveLength(0)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const retried = await h.events(node.slug)
    expect(
      retried.filter((event) => event.type === 'integration.verification-failed'),
    ).toHaveLength(1)
    expect(retried.filter((event) => event.type === 'escalation.raised')).toHaveLength(0)
  } finally {
    await h.cleanup()
  }
})
