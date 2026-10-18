import { expect, test } from 'bun:test'
import { makeHarness, happyHandlers, readyTicket, writeFileIn } from './harness'
import { reduceBuild } from '../kernel/reducer'

for (const route of ['same', 'ancestor', 'sibling', 'descendant', 'root', 'node-root'] as const) {
  test(`real Git blocker presence: ${route}`, async () => {
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
      await h.tickets.transition('DEP', 'Ready')
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
        await h.forgeAdapter.squashMerge(h.origin, secondState.pr!.number, secondState.pr!.headSha)
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
        await h.forgeAdapter.squashMerge(h.origin, betaState.pr!.number, betaHead)
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
  })
}

for (const trailerFlag of [undefined, false]) {
  test(`unchanged root head refreshes historical trailerless proof (${trailerFlag})`, async () => {
    const { git } = await import('./harness')
    const { DISPATCHER } = await import('../events/envelope')
    const h = await makeHarness({
      localGitForge: true,
      handlers: happyHandlers(),
      tickets: [
        { ...readyTicket('NODE', { title: 'Empty node' }), kind: 'node' },
        readyTicket('BLOCK', { title: 'External change', state: 'In Progress' }),
        { ...readyTicket('DEP', { title: 'Dependent work' }), blockedBy: ['BLOCK'] },
      ],
    })
    try {
      await git(
        ['commit', '--allow-empty', '-m', 'external queue landing without identity'],
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
