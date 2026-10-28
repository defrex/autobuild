import { requestNodeRestack } from '../operator/restack'
import { expect, test } from 'bun:test'
import { makeHarness, happyHandlers, readyTicket, writeFileIn, CONFIG_TOML } from './harness'
import { reduceBuild } from '../kernel/reducer'

for (const scenario of [
  'same',
  'ancestor',
  'sibling',
  'descendant',
  'root',
  'node-root',
  'sibling-restack',
  'descendant-restack',
  'root-restack',
] as const) {
  // Real-Git presence/restack cases hit 5s in the 4-vCPU sandbox unit run;
  // measured sibling at 5.47s and node-root at 7.01s alongside the suite.
  // Retain all ancestry assertions with explicit headroom for this group.
  const timeout = 15_000
  test(
    `real Git blocker presence: ${scenario}`,
    async () => {
      const restacked = scenario.endsWith('-restack')
      const route = scenario.replace(/-restack$/, '')
      const blockerTarget = route === 'ancestor' ? 'A' : 'B'
      const dependentTarget =
        route === 'same'
          ? 'B'
          : route === 'descendant'
            ? 'A'
            : route === 'root' || route === 'node-root'
              ? undefined
              : 'C'
      const handlers = happyHandlers()
      const implement = handlers.implement!
      let implementations = 0
      handlers.implement = async (cli) => {
        await writeFileIn(cli.ws, 'unique-change.txt', `${++implementations}\n`)
        await implement(cli)
      }
      const h = await makeHarness({
        localGitForge: true,
        configToml: `${CONFIG_TOML}\n[[merge]]\nfrom = "leaf"\nmode = "consent"\n`,
        handlers,
        tickets: [
          { ...readyTicket('A', { title: 'Node alpha' }), kind: 'node' },
          { ...readyTicket('B', { title: 'Node beta' }), kind: 'node', target: 'A' },
          { ...readyTicket('C', { title: 'Node gamma' }), kind: 'node', target: 'A' },
          { ...readyTicket('BLOCK', { title: 'Prerequisite change' }), target: blockerTarget },
          {
            ...readyTicket('DEP', { title: 'Dependent change', state: 'In Progress' }),
            target: dependentTarget,
            blockedBy: [route === 'node-root' ? 'B' : 'BLOCK'],
          },
        ],
      })
      try {
        for (let i = 0; i < 4; i++) await h.dispatcher.tick()
        const record = async (id: string) =>
          (await h.store.listBuilds()).find((r) => r.ticket?.id === id)
        const blocker = (await record('BLOCK'))!
        expect(blocker).toBeDefined()
        await h.runLatest()
        if (!restacked) await h.tickets.transition('DEP', 'Ready')
        await h.dispatcher.tick()
        expect(await record('DEP')).toBeUndefined()
        const state = reduceBuild(await h.events(blocker.slug))
        await h.forgeAdapter.squashMerge(h.origin, state.pr!.number, state.pr!.headSha)
        await h.dispatcher.tick()
        if (route === 'node-root') {
          h.tickets.add({
            ...readyTicket('SECOND', { title: 'Second prerequisite change' }),
            target: 'B',
          })
          h.clock.advance(60_000)
          await h.dispatcher.tick()
          await h.runLatest()
          const second = (await record('SECOND'))!
          const secondState = reduceBuild(await h.events(second.slug))
          await h.forgeAdapter.squashMerge(
            h.origin,
            secondState.pr!.number,
            secondState.pr!.headSha,
          )
          await h.dispatcher.tick()
        }
        if (
          route === 'sibling' ||
          route === 'descendant' ||
          route === 'root' ||
          route === 'node-root'
        ) {
          expect(await record('DEP')).toBeUndefined()
          const beta = (await record('B'))!
          await h.dispatcher.tick()
          const betaState = reduceBuild(await h.events(beta.slug))
          expect(betaState.pr).toBeDefined()
          const betaHead = await h.forgeAdapter.remoteBranchSha!(beta.branch!)
          await h.forgeAdapter.squashMerge(h.origin, betaState.pr!.number, betaHead, {
            buildSlug: beta.slug,
          })
          if (route === 'node-root') {
            const { git } = await import('./harness')
            const tree = await git(['rev-parse', `${betaHead}^{tree}`], h.origin)
            const moved = await git(
              ['commit-tree', tree, '-p', betaHead, '-m', 'unlanded source movement'],
              h.origin,
            )
            await git(['update-ref', `refs/heads/${beta.branch}`, moved], h.origin)
            await h.dispatcher.tick()
            const contribution = reduceBuild(await h.events(beta.slug)).nodeRestack?.contribution
            expect(contribution?.head).toBe(betaHead)
            expect(contribution?.identities).not.toContain(`foreign:${moved}`)
            expect(contribution?.identities).toContain(`build:${(await record('SECOND'))!.slug}`)
          }
        }
        if (restacked) {
          await h.dispatcher.tick()
          const { git } = await import('./harness')
          await git(['commit', '--allow-empty', '-m', 'unrelated root advancement'], h.origin)
          for (let i = 0; i < 4; i++) await h.dispatcher.tick()
          const beta = (await record('B'))!
          const alpha = (await record('A'))!
          const landing = reduceBuild(await h.events(beta.slug)).mergedSha!
          const alphaHead = await h.forgeAdapter.remoteBranchSha!(alpha.branch!)
          // No eager replay: the unchanged contribution still includes its landing.
          expect((await git(['rev-list', alphaHead], h.origin)).split('\n')).toContain(landing)
          expect(await record('DEP')).toBeUndefined()
          await h.tickets.transition('DEP', 'Ready')
          h.clock.advance(60_000)
        }
        if (route === 'root' || route === 'node-root') {
          await h.dispatcher.tick()
          expect(await record('DEP')).toBeUndefined()
          const alpha = (await record('A'))!
          const alphaState = reduceBuild(await h.events(alpha.slug))
          expect(alphaState.pr).toBeDefined()
          await h.forgeAdapter.squashMerge(h.origin, alphaState.pr!.number, alphaState.pr!.headSha)
        }
        for (let i = 0; i < 3; i++) await h.dispatcher.tick()
        expect(await record('DEP')).toBeDefined()
      } finally {
        await h.cleanup()
      }
    },
    timeout,
  )
}

for (const trailerFlag of [undefined, false]) {
  test(`unchanged root head refreshes historical trailerless proof (${trailerFlag})`, async () => {
    const { git } = await import('./harness')
    const { DISPATCHER } = await import('../events/envelope')
    const h = await makeHarness({
      localGitForge: true,
      configToml: `${CONFIG_TOML}\n[[merge]]\nfrom = "leaf"\nmode = "consent"\n`,
      handlers: happyHandlers(),
      tickets: [
        { ...readyTicket('NODE', { title: 'Empty node' }), kind: 'node' },
        readyTicket('BLOCK', { title: 'External change', state: 'In Progress' }),
        { ...readyTicket('DEP', { title: 'Dependent work' }), blockedBy: ['BLOCK'] },
      ],
    })
    try {
      await git(
        ['commit', '--allow-empty', '-m', 'external queue merge without identity'],
        h.origin,
      )
      const sha = await git(['rev-parse', 'HEAD'], h.origin)
      const ticket = (await h.tickets.get('BLOCK'))!.ref
      await h.store.createBuild({
        slug: 'historical-blocker',
        repo: h.origin,
        ticket,
        created: {
          actor: DISPATCHER,
          type: 'build.created',
          payload: { ticket, repo: h.origin, baseBranch: 'main' },
        },
      })
      await h.store.append('historical-blocker', {
        actor: DISPATCHER,
        type: 'build.completed',
        payload: { outcome: 'merged' },
      })
      const list = h.tickets.listReady.bind(h.tickets)
      h.tickets.listReady = async (criteria) => {
        const listing = await list(criteria)
        return {
          ...listing,
          tickets: listing.tickets.map((t) =>
            t.ref.id === 'DEP' ? { ...t, blockersResolved: true } : t,
          ),
        }
      }
      const first = await h.dispatcher.tick()
      expect(first.dependencyDiagnostics.join(' ')).toContain('blocker BLOCK is not present')
      expect(h.tickets.claims).not.toContain('DEP')
      const journal = await h.store.getRepoEvents(h.origin)
      expect(journal.some((event) => event.type === 'change-presence.observed')).toBe(true)
      await h.store.append('historical-blocker', {
        actor: DISPATCHER,
        type: 'pr.merged',
        payload: {
          sha,
          ...(trailerFlag === undefined ? {} : { buildTrailerPresent: trailerFlag }),
        },
      })
      if (trailerFlag === undefined) {
        const snapshot = h.forgeAdapter.snapshotBase!.bind(h.forgeAdapter)
        h.forgeAdapter.snapshotBase = async () => {
          throw new Error('snapshot unavailable')
        }
        const unavailable = await h.dispatcher.tick()
        expect(unavailable.dependencyDiagnostics.join(' ')).toContain(
          'blocker BLOCK presence unavailable in root:main',
        )
        expect(h.tickets.claims).not.toContain('DEP')
        h.forgeAdapter.snapshotBase = snapshot
        h.clock.advance(60_000)
      }
      if (trailerFlag === false) {
        const snapshot = h.forgeAdapter.snapshotBase!.bind(h.forgeAdapter)
        let moved = false
        h.forgeAdapter.snapshotBase = async (input) => {
          const head = await snapshot(input)
          if (!moved && input.destinationRef.endsWith('/presence')) {
            moved = true
            await git(['commit', '--allow-empty', '-m', 'target moved during preflight'], h.origin)
          }
          return head
        }
        const raced = await h.dispatcher.tick()
        expect(raced.dependencyDiagnostics.join(' ')).toContain('moved after dependency preflight')
        expect(h.tickets.claims).not.toContain('DEP')
        h.clock.advance(60_000)
      }
      await h.dispatcher.tick()
      expect(h.tickets.claims).toContain('DEP')
      expect((await h.tickets.get('BLOCK'))!.state).toBe('In Progress')
      if (trailerFlag === undefined) expect(await git(['rev-parse', 'HEAD'], h.origin)).toBe(sha)
    } finally {
      await h.cleanup()
    }
  })
}

for (const blocked of [false, true]) {
  test(`admission reads no full historical build facts with settled nodes (blocked=${blocked})`, async () => {
    const { git } = await import('./harness')
    const { DISPATCHER } = await import('../events/envelope')
    const reads: string[] = []
    const h = await makeHarness({
      localGitForge: true,
      configToml: `${CONFIG_TOML}\n[[merge]]\nfrom = "leaf"\nmode = "consent"\n`,
      handlers: happyHandlers(),
      tickets: [
        {
          ...readyTicket('DEP', { title: 'Ready work' }),
          ...(blocked ? { blockedBy: ['H-0'] } : {}),
        },
        readyTicket('H-0', { state: 'Done' }),
      ],
      storeAdapter: async (backing) => ({
        storeRef: 'memory',
        store: new Proxy(backing, {
          get(target, key) {
            if (key === 'getReducerValue')
              return async (...args: Parameters<typeof backing.getReducerValue>) => {
                if (args[0].kind === 'build' && args[1].reducer === 'buildReadFacts')
                  reads.push(args[0].slug)
                return target.getReducerValue(...args)
              }
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      }),
    })
    try {
      const sha = await git(['rev-parse', 'HEAD'], h.origin)
      for (let i = 0; i < 50; i++) {
        const slug = `historical-${i}`
        const ticket = { source: 'fake', id: `H-${i}` }
        await h.store.createBuild({
          slug,
          repo: h.origin,
          ticket,
          created: {
            actor: DISPATCHER,
            type: 'build.created',
            payload: {
              ticket,
              repo: h.origin,
              baseBranch: 'main',
              ...(i === 49 ? { kind: 'node' as const } : {}),
            },
          },
        })
        if (i === 49)
          await h.store.append(slug, {
            actor: DISPATCHER,
            type: 'node.contribution-recorded',
            payload: { landing: sha, head: sha, base: sha, identities: [] },
          })
        await h.store.append(slug, { actor: DISPATCHER, type: 'pr.merged', payload: { sha } })
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'build.completed',
          payload: { outcome: 'merged' },
        })
      }
      if (blocked) {
        // A legacy observation can have identical evidence revisions but an
        // incomplete identity set. The upgraded derivation must not reuse it.
        const digests = await h.store.getRepoBuildDigests(h.origin)
        const evidence = JSON.stringify(
          [...digests].map(([slug, digest]) => [slug, digest.readinessChangeSeq]).sort(),
        )
        await h.store.ensureRepo(h.origin)
        await h.store.appendRepo(h.origin, {
          actor: DISPATCHER,
          type: 'change-presence.observed',
          payload: {
            branch: 'main',
            destination: 'root:main',
            head: sha,
            evidence,
            identities: [],
          },
        })
      }
      reads.length = 0
      await h.dispatcher.tick()
      expect(h.tickets.claims).toContain('DEP')
      expect(reads.filter((slug) => slug.startsWith('historical-'))).toEqual([])
      await h.runLatest()
      const work = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'DEP')!
      const state = reduceBuild(await h.events(work.slug))
      await h.forgeAdapter.squashMerge(h.origin, state.pr!.number, state.pr!.headSha)
      reads.length = 0
      h.clock.advance(60_000)
      await h.dispatcher.tick()
      expect(reads.filter((slug) => slug.startsWith('historical-'))).toEqual([])
    } finally {
      await h.cleanup()
    }
  })
}

test('a trailerless work merge survives node replay and subsequent squash transport to root', async () => {
  const { git } = await import('./harness')
  const { DISPATCHER } = await import('../events/envelope')
  const h = await makeHarness({
    localGitForge: true,
    handlers: happyHandlers(),
    tickets: [
      { ...readyTicket('NODE', { title: 'Node with foreign merge' }), kind: 'node' },
      readyTicket('BLOCK', { state: 'Done' }),
      {
        ...readyTicket('DEP', { title: 'Node dependent', state: 'In Progress' }),
        target: 'NODE',
        blockedBy: ['BLOCK'],
      },
      {
        ...readyTicket('ROOT', { title: 'Root dependent', state: 'In Progress' }),
        blockedBy: ['BLOCK'],
      },
    ],
  })
  try {
    await h.dispatcher.tick()
    const node = (await h.store.listBuilds()).find((record) => record.ticket?.id === 'NODE')!
    const base = await h.forgeAdapter.remoteBranchSha!(node.branch!)
    const tree = await git(['rev-parse', `${base}^{tree}`], h.origin)
    const landing = await git(
      ['commit-tree', tree, '-p', base, '-m', 'external trailerless merge'],
      h.origin,
    )
    await git(['update-ref', `refs/heads/${node.branch}`, landing], h.origin)
    const ticket = (await h.tickets.get('BLOCK'))!.ref
    await h.store.createBuild({
      slug: 'trailerless-work',
      repo: h.origin,
      ticket,
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ticket, repo: h.origin, baseBranch: node.branch! },
      },
    })
    await h.store.append('trailerless-work', {
      actor: DISPATCHER,
      type: 'pr.merged',
      payload: { sha: landing, buildTrailerPresent: false },
    })
    await h.store.append('trailerless-work', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    await git(['commit', '--allow-empty', '-m', 'root moved before admission'], h.origin)
    await requestNodeRestack({ store: h.store, repo: h.origin, slug: node.slug, user: 'operator' })
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const head = await h.forgeAdapter.remoteBranchSha!(node.branch!)
    expect((await git(['rev-list', head], h.origin)).split('\n')).not.toContain(landing)
    expect(reduceBuild(await h.events(node.slug)).nodeRestack?.foreignAliases?.[head]).toBe(landing)
    await h.tickets.transition('DEP', 'Ready')
    await h.tickets.transition('ROOT', 'Ready')
    h.clock.advance(60_000)
    await h.dispatcher.tick()
    expect(h.tickets.claims).toContain('DEP')
    expect(h.tickets.claims).not.toContain('ROOT')
    const state = reduceBuild(await h.events(node.slug))
    await h.forgeAdapter.squashMerge(h.origin, state.pr!.number, head)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    expect(reduceBuild(await h.events(node.slug)).nodeRestack?.contribution?.identities).toContain(
      'build:trailerless-work',
    )
    expect(h.tickets.claims).toContain('ROOT')
  } finally {
    await h.cleanup()
  }
})

for (const saturated of [false, true])
  test(`queued presence demand refreshes only the required nested path (saturated=${saturated})`, async () => {
    const h = await makeHarness({
      localGitForge: true,
      handlers: happyHandlers(),
      tickets: [
        { ...readyTicket('A', { title: 'Ancestor node' }), kind: 'node' },
        { ...readyTicket('B', { title: 'Nested target' }), kind: 'node', target: 'A' },
        { ...readyTicket('S', { title: 'Unrelated sibling' }), kind: 'node' },
        {
          ...readyTicket('OPEN', { title: 'Keep target collecting', state: 'Backlog' }),
          target: 'B',
        },
        readyTicket('BLOCK', { title: 'Root prerequisite' }),
        {
          ...readyTicket('DEP', {
            title: 'Queued dependent',
            ...(saturated ? { state: 'Backlog' } : {}),
          }),
          target: 'B',
          blockedBy: ['BLOCK'],
        },
      ],
    })
    try {
      for (let i = 0; i < 4; i++) await h.dispatcher.tick()
      const record = async (id: string) =>
        (await h.store.listBuilds()).find((r) => r.ticket?.id === id)
      expect(await record('DEP')).toBeUndefined()
      const blocker = (await record('BLOCK'))!
      await h.runLatest()
      const state = reduceBuild(await h.events(blocker.slug))
      await h.forgeAdapter.squashMerge(h.origin, state.pr!.number, state.pr!.headSha)
      if (saturated) {
        await h.dispatcher.tick()
        for (const id of ['BUSY-1', 'BUSY-2'])
          h.tickets.add(readyTicket(id, { title: `Busy work ${id}` }))
        h.clock.advance(60_000)
        await h.dispatcher.tick()
        await h.tickets.transition('DEP', 'Ready')
        h.clock.advance(60_000)
      }
      for (let i = 0; i < 8; i++) await h.dispatcher.tick()
      if (saturated) {
        expect(await record('DEP')).toBeUndefined()
        const { controlBuild } = await import('../cli/build-control')
        for (const id of ['BUSY-1', 'BUSY-2'])
          await controlBuild({
            store: h.store,
            repo: h.origin,
            slug: (await record(id))!.slug,
            action: { kind: 'abort' },
          })
        for (let i = 0; i < 3; i++) await h.dispatcher.tick()
      }
      expect(await record('DEP')).toBeDefined()
      for (const id of ['A', 'B']) {
        const events = await h.events((await record(id))!.slug)
        expect(
          events.some(
            (e) => e.type === 'node.restack-requested' && e.payload.reason === 'presence',
          ),
        ).toBe(true)
        expect(events.some((e) => e.type === 'node.writer-settled')).toBe(true)
      }
      expect(
        (await h.events((await record('S'))!.slug)).some((e) => e.type === 'node.writer-reserved'),
      ).toBe(false)
    } finally {
      await h.cleanup()
    }
    // Real-Git queued-path refresh took 5.67s in the 4-vCPU sandbox alongside
    // the unit suite; retain both capacity states and all presence assertions.
  }, 15_000)
