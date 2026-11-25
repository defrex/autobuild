/**
 * A leaf whose recorded base stops being an ancestor of its target leaves the
 * `target-rewritten` wait (SPEC §7.4, #1274). With no work of its own it is
 * reprovisioned from the current target by itself, including after a runner
 * died mid-reset; with work it raises one escalation, and an operator's
 * accept-target restacks its own commits onto the current target.
 * In-memory store, scripted agents, fake forge, real git worktrees.
 */
import { afterEach, expect, test } from 'bun:test'
import { controlBuild } from '../cli/build-control'
import type { AbEvent } from '../events/catalog'
import type { BuildStore } from '../store/types'
import {
  CONFIG_TOML,
  GIT_ID,
  commitAll,
  git,
  happyHandlers,
  makeHarness,
  ofType,
  readyTicket,
  writeFileIn,
  type Cli,
  type E2eHarness,
  type SkillHandlers,
} from './harness'

const harnesses: E2eHarness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

async function onlyBuild(h: E2eHarness): Promise<string> {
  const [record] = await h.store.listBuilds()
  if (record === undefined) throw new Error('no build')
  return record.slug
}

/** Force-push origin main to an orphan commit with the same tree: main no
 * longer descends from the build's base. */
async function rewriteMain(h: E2eHarness, message = 'rewritten main'): Promise<string> {
  const current = await git(['rev-parse', 'refs/heads/main'], h.remote)
  const sha = await git(
    [...GIT_ID, 'commit-tree', `${current}^{tree}`, '-m', `${message} ${Date.now()}`],
    h.remote,
  )
  await git(['update-ref', 'refs/heads/main', sha], h.remote)
  return sha
}

/** Advance origin main by one empty commit on top of its current head. */
async function advanceMain(h: E2eHarness, message: string): Promise<string> {
  const current = await git(['rev-parse', 'refs/heads/main'], h.remote)
  const sha = await git(
    [...GIT_ID, 'commit-tree', `${current}^{tree}`, '-p', current, '-m', message],
    h.remote,
  )
  await git(['update-ref', 'refs/heads/main', sha], h.remote)
  return sha
}

const head = async (cli: Cli) => git(['rev-parse', 'HEAD'], cli.ws)

async function answer(h: E2eHarness, slug: string, accept = false) {
  await controlBuild({
    store: h.store,
    repo: h.origin,
    slug,
    env: { USER: 'operator' },
    action: accept
      ? { kind: 'answer', resolve: { kind: 'accept-target' } }
      : { kind: 'answer', text: 'continue' },
  })
}

/** Tick the dispatcher (observing the target) and run whatever it launched. */
async function tickAndRun(h: E2eHarness) {
  h.clock.advance(3_600_001)
  const before = h.launched.length
  await h.dispatcher.tick()
  return h.launched.length > before ? h.runLatest() : undefined
}

const targetEscalations = (events: AbEvent[]) =>
  ofType(events, 'escalation.raised').filter((e) => e.payload.policyCause === 'target-rewritten')

/** The first `stops` plan sessions stop on a question, so the build has
 * done no work (the first also rewrites main); later plan sessions record
 * their HEAD and plan normally. */
function planStops(h: () => E2eHarness, heads: string[], stops = 1): SkillHandlers {
  const handlers = happyHandlers()
  const plan = handlers.plan!
  let sessions = 0
  handlers.plan = async (cli) => {
    if (sessions++ < stops) {
      await cli.run(['context'])
      if (sessions === 1) await rewriteMain(h())
      await cli.run(['escalate', 'scenario stops after plan starts'])
      return
    }
    heads.push(await head(cli))
    await plan(cli)
  }
  return handlers
}

/** A store whose first `target.rewrite-recovered` append fails after the
 * reset ran, as a runner dying between the checkout and its record would. */
function failFirstRecovered() {
  let armed = true
  return async (backing: import('../store/memory').MemoryBuildStore) => {
    const store: BuildStore = new Proxy(backing, {
      get(target, key) {
        if (key === 'scopeBuild')
          return (slug: string) => backing.scopeBuild.call(store as typeof backing, slug)
        if (key === 'appendIfCurrent')
          return async (...args: Parameters<BuildStore['appendIfCurrent']>) => {
            if (armed && args[2].type === 'target.rewrite-recovered') {
              armed = false
              throw new Error('injected: runner died after the reset')
            }
            return target.appendIfCurrent(...args)
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { storeRef: 'memory', store }
  }
}

/** Dispatch, stop at plan with main rewritten, observe the rewrite and
 * answer the stopping question; the next tick runs recovery. */
async function stoppedOnRewrite(h: E2eHarness): Promise<string> {
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest()
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  expect(ofType(await h.events(slug), 'target.rewritten')).toHaveLength(1)
  await answer(h, slug)
  return slug
}

test('a leaf with no work is reprovisioned from the rewritten target and plans without an operator', async () => {
  const heads: string[] = []
  let harness: E2eHarness | undefined
  const h = await makeHarness({
    handlers: planStops(() => harness!, heads),
    tickets: [readyTicket('T-A')],
  })
  harness = h
  harnesses.push(h)
  const slug = await stoppedOnRewrite(h)
  const state = await tickAndRun(h)
  expect(h.cliErrors).toEqual([])
  const events = await h.events(slug)
  const main = await git(['rev-parse', 'refs/heads/main'], h.remote)
  const [recovered] = ofType(events, 'target.rewrite-recovered')
  expect(recovered?.payload).toMatchObject({ recovery: 'reprovisioned', sha: main })
  expect(ofType(events, 'target.rewrite-reprovision-prepared')).toHaveLength(1)
  expect(targetEscalations(events)).toEqual([])
  // The plan re-runs after the reset, on the rewritten target.
  const replanned = ofType(events, 'plan.started').at(-1)!
  expect(replanned.seq).toBeGreaterThan(recovered!.seq)
  expect(heads).toEqual([main])
  expect(state?.prState).toBe('open')
  const [restacked] = ofType(events, 'restack.completed')
  expect(restacked?.payload.targetBase).toBe(main)
}, 120_000)

test('a reset interrupted before its record completes forward on the prepared target', async () => {
  const heads: string[] = []
  let harness: E2eHarness | undefined
  const h = await makeHarness({
    handlers: planStops(() => harness!, heads),
    tickets: [readyTicket('T-A')],
    storeAdapter: failFirstRecovered(),
  })
  harness = h
  harnesses.push(h)
  const slug = await stoppedOnRewrite(h)
  await tickAndRun(h).catch(() => undefined)
  let events = await h.events(slug)
  const [prepared] = ofType(events, 'target.rewrite-reprovision-prepared')
  expect(prepared).toBeDefined()
  expect(ofType(events, 'target.rewrite-recovered')).toEqual([])
  // The target moves forward before the next runner starts.
  const forward = await advanceMain(h, 'forward')
  const state = await tickAndRun(h)
  expect(h.cliErrors).toEqual([])
  events = await h.events(slug)
  const recovered = ofType(events, 'target.rewrite-recovered')
  expect(recovered.map((e) => e.payload)).toEqual([
    expect.objectContaining({ recovery: 'reprovisioned', sha: prepared!.payload.sha }),
  ])
  expect(targetEscalations(events)).toEqual([])
  expect(ofType(events, 'plan.started').at(-1)!.seq).toBeGreaterThan(recovered[0]!.seq)
  const moved = ofType(events, 'target.moved').filter((e) => e.seq > recovered[0]!.seq)
  expect(moved.map((e) => e.payload.sha)).toContain(forward)
  expect(state?.prState).toBe('open')
}, 120_000)

test('a leaf with work escalates once and recovers through accept-target', async () => {
  let harness: E2eHarness | undefined
  const handlers = happyHandlers()
  const review = handlers['code-review']!
  let reviews = 0
  handlers['code-review'] = async (cli) => {
    if (reviews++ === 0) {
      await cli.run(['context'])
      await rewriteMain(harness!)
      await cli.run(['escalate', 'scenario stops in code review'])
      return
    }
    await review(cli)
  }
  const h = await makeHarness({ handlers, tickets: [readyTicket('T-A')] })
  harness = h
  harnesses.push(h)
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest()
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  await answer(h, slug)
  await tickAndRun(h)
  let events = await h.events(slug)
  const implemented = ofType(events, 'implement.completed')[0]!.payload.commits.head
  let raised = targetEscalations(events)
  expect(raised).toHaveLength(1)
  const rejected = ofType(events, 'target.rewritten')[0]!.payload
  expect(raised[0]!.payload.question).toContain(rejected.previousSha.slice(0, 7))
  expect(raised[0]!.payload.question).toContain(rejected.sha.slice(0, 7))
  expect(raised[0]!.payload.question).toContain(implemented.slice(0, 7))
  // Another rewrite of the same rejected baseline raises nothing new.
  const main = await rewriteMain(h, 'rewritten again')
  await tickAndRun(h)
  events = await h.events(slug)
  raised = targetEscalations(events)
  expect(raised).toHaveLength(1)
  expect(ofType(events, 'target.rewritten').at(-1)!.payload.sha).toBe(main)

  await answer(h, slug, true)
  const state = await tickAndRun(h)
  expect(h.cliErrors).toEqual([])
  expect(state?.prState).toBe('open')
  events = await h.events(slug)
  expect(ofType(events, 'target.rewrite-recovered').map((e) => e.payload)).toEqual([
    expect.objectContaining({ recovery: 'accepted', sha: main, escalation: raised[0]!.payload.id }),
  ])
  const restacked = ofType(events, 'restack.completed').at(-1)!
  expect(restacked.payload.targetBase).toBe(main)
  // The published branch carries the build's change on top of the current main.
  const branch = (await h.store.getBuild(slug))!.branch!
  const published = await git(['rev-parse', `refs/heads/${branch}`], h.remote)
  expect(published).toBe(restacked.payload.headSha)
  await git(['merge-base', '--is-ancestor', main, published], h.remote)
  expect(await git(['show', `${published}:rate-limit.txt`], h.remote)).toContain('throttle')
}, 180_000)

test('an accept withholds the restack until the open implement round publishes its local commit', async () => {
  let harness: E2eHarness | undefined
  const handlers = happyHandlers()
  const implement = handlers.implement!
  const review = handlers['code-review']!
  let reviews = 0
  let localCommit = ''
  handlers['code-review'] = async (cli) => {
    if (reviews++ > 0) return review(cli)
    await cli.run(['context'])
    const notes = await writeFileIn(cli.ws, '.ab/code-review.md', 'Add a second change.\n')
    const findings = await writeFileIn(
      cli.ws,
      '.ab/findings-draft.json',
      JSON.stringify([{ severity: 'blocking', summary: 'add a second change', persists: [] }]),
    )
    await cli.run(['verdict', 'revise', '--findings', findings, '--notes', notes])
  }
  handlers.implement = async (cli) => {
    if (cli.round !== 2 || localCommit !== '') return implement(cli)
    // Round 2 commits locally, then stops before completing: the commit is
    // unpublished and owned by this open implement occurrence.
    await cli.run(['context'])
    await writeFileIn(cli.ws, 'second.txt', 'second change\n')
    localCommit = await commitAll(cli.ws, 'implement: second change')
    await rewriteMain(harness!)
    await cli.run(['escalate', 'scenario stops inside implement round 2'])
  }
  const h = await makeHarness({ handlers, tickets: [readyTicket('T-A')] })
  harness = h
  harnesses.push(h)
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest()
  expect(localCommit).not.toBe('')
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  await answer(h, slug)
  await tickAndRun(h)
  let events = await h.events(slug)
  const published = ofType(events, 'implement.completed')[0]!.payload.commits.head
  const [raised] = targetEscalations(events)
  expect(raised?.payload.question).toContain(published.slice(0, 7))
  expect(raised?.payload.question).toContain(localCommit.slice(0, 7))

  await answer(h, slug, true)
  const state = await tickAndRun(h)
  expect(h.cliErrors).toEqual([])
  events = await h.events(slug)
  const [accepted] = ofType(events, 'target.rewrite-recovered')
  expect(accepted?.payload).toMatchObject({
    recovery: 'accepted',
    pendingLocal: { head: localCommit, owner: { kind: 'phase', phase: 'implement' } },
  })
  const completed = ofType(events, 'implement.completed').at(-1)!
  const restacked = ofType(events, 'restack.completed').at(-1)!
  expect(completed.seq).toBeGreaterThan(accepted!.seq)
  expect(
    ofType(events, 'restack.prepared').filter(
      (e) => e.seq > accepted!.seq && e.seq < completed.seq,
    ),
  ).toEqual([])
  const main = await git(['rev-parse', 'refs/heads/main'], h.remote)
  expect(restacked.payload.targetBase).toBe(main)
  const head = restacked.payload.headSha
  await git(['merge-base', '--is-ancestor', main, head], h.remote)
  expect(await git(['show', `${head}:second.txt`], h.remote)).toBe('second change')
  expect(await git(['show', `${head}:rate-limit.txt`], h.remote)).toContain('throttle')
  expect(state?.prState).toBe('open')
}, 180_000)

test('an interrupted finalize post-step owns its local commit through an accept', async () => {
  let failStep = true
  const h = await makeHarness({
    handlers: happyHandlers(),
    tickets: [readyTicket('T-A')],
    configToml: `${CONFIG_TOML.replace(
      '[commands]\n',
      '[commands]\nstamp = "test -f step.txt || (echo x > step.txt && git add step.txt && git commit -qm step)"\n',
    )}
[finalize]
steps = ["stamp"]

[finalize.stamp]
kind = "check"
command = "stamp"
`,
    // The step's completion record is lost once, after its command committed.
    storeAdapter: async (backing) => {
      const fail = (write: { type: string; payload: unknown }) => {
        if (failStep && write.type === 'finalize.step-completed') {
          failStep = false
          throw new Error('injected: runner died before recording the post-step')
        }
      }
      const store: BuildStore = new Proxy(backing, {
        get(target, key) {
          if (key === 'scopeBuild')
            return (slug: string) => backing.scopeBuild.call(store as typeof backing, slug)
          if (key === 'append')
            return async (...args: Parameters<BuildStore['append']>) => {
              fail(args[1])
              return target.append(...args)
            }
          if (key === 'appendIfCurrent')
            return async (...args: Parameters<BuildStore['appendIfCurrent']>) => {
              fail(args[2])
              return target.appendIfCurrent(...args)
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return { storeRef: 'memory', store }
    },
  })
  harnesses.push(h)
  await h.dispatcher.tick()
  const slug = await onlyBuild(h)
  await h.runLatest().catch(() => undefined)
  let events = await h.events(slug)
  expect(ofType(events, 'finalize.step-started').map((e) => e.payload.step)).toEqual(['stamp'])
  expect(ofType(events, 'finalize.step-completed')).toEqual([])
  const main = await rewriteMain(h)
  await tickAndRun(h)
  events = await h.events(slug)
  const [raised] = targetEscalations(events)
  expect(raised?.payload.question).toContain(' step')

  await answer(h, slug, true)
  const state = await tickAndRun(h)
  expect(h.cliErrors).toEqual([])
  events = await h.events(slug)
  const [accepted] = ofType(events, 'target.rewrite-recovered')
  expect(accepted?.payload.pendingLocal?.owner).toMatchObject({
    kind: 'finalize-step',
    step: 'stamp',
  })
  const stamped = ofType(events, 'finalize.step-completed').at(-1)!
  expect(stamped.payload).toMatchObject({ step: 'stamp', ok: true, headSha: expect.any(String) })
  const restacked = ofType(events, 'restack.completed').at(-1)!
  expect(restacked.seq).toBeGreaterThan(stamped.seq)
  expect(restacked.payload.targetBase).toBe(main)
  const head = restacked.payload.headSha
  await git(['merge-base', '--is-ancestor', main, head], h.remote)
  expect(await git(['show', `${head}:step.txt`], h.remote)).toBe('x')
  expect(await git(['show', `${head}:rate-limit.txt`], h.remote)).toContain('throttle')
  expect(state?.prState).toBe('open')
}, 180_000)

test('an interrupted reset whose rewrite cleared completes first, then heals onto the restored target', async () => {
  const heads: string[] = []
  let harness: E2eHarness | undefined
  const h = await makeHarness({
    handlers: planStops(() => harness!, heads, 2),
    tickets: [readyTicket('T-A')],
    storeAdapter: failFirstRecovered(),
  })
  harness = h
  harnesses.push(h)
  const original = await git(['rev-parse', 'refs/heads/main'], h.remote)
  const slug = await stoppedOnRewrite(h)
  await tickAndRun(h).catch(() => undefined)
  const [prepared] = ofType(await h.events(slug), 'target.rewrite-reprovision-prepared')
  expect(prepared).toBeDefined()
  // main returns to its original history before the next runner starts.
  await git(['update-ref', 'refs/heads/main', original], h.remote)
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  let facts = await h.events(slug)
  expect(ofType(facts, 'target.rewrite-cleared')).toHaveLength(1)
  // The cleared rewrite leaves the reset open, and the runner completes it
  // before any phase; the plan session it reaches stops on a question.
  await h.runLatest()
  facts = await h.events(slug)
  const [first] = ofType(facts, 'target.rewrite-recovered')
  expect(first?.payload).toMatchObject({ recovery: 'reprovisioned', sha: prepared!.payload.sha })
  const replans = ofType(facts, 'plan.started').filter((e) => e.seq > prepared!.seq)
  expect(replans[0]!.seq).toBeGreaterThan(first!.seq)
  // The next observation judges the restored main against the prepared base.
  h.clock.advance(3_600_001)
  await h.dispatcher.tick()
  facts = await h.events(slug)
  expect(ofType(facts, 'target.rewritten').at(-1)!.payload).toMatchObject({
    previousSha: prepared!.payload.sha,
    sha: original,
  })
  await answer(h, slug)
  const state = await tickAndRun(h)
  expect(h.cliErrors).toEqual([])
  facts = await h.events(slug)
  expect(ofType(facts, 'target.rewrite-recovered').map((e) => e.payload.sha)).toEqual([
    prepared!.payload.sha,
    original,
  ])
  expect(targetEscalations(facts)).toEqual([])
  expect(heads).toEqual([original])
  expect(state?.prState).toBe('open')
}, 180_000)
