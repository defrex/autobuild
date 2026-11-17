/**
 * `[[merge]]` path predicates (GitHub #942): each candidate head is decided on
 * its own recorded changed paths. A protective `paths` rule placed first holds
 * any change to policy files; a `within` rule auto-merges documentation-only
 * changes. In-memory: memory store, fakes, logical workspaces, manual clock.
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { Config } from '../config/schema'
import type { EventWrite } from '../events/catalog'
import { DISPATCHER, KERNEL, agentActor, humanActor, type Actor } from '../events/envelope'
import type { EventPayload, EventType } from '../events/payloads'
import { sequentialIds } from '../ids'
import { decideNextFromFacts, type Decision } from '../kernel/engine'
import { headPathsWrite, HEAD_PATHS_ARTIFACT } from '../kernel/head-paths'
import { suspendNativeLanding } from '../kernel/landing-publication'
import { awaitsConsent, landRefusalReason } from '../kernel/landing-readiness'
import { consentRevocation } from '../kernel/consent-revocation'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import { Dispatcher } from '../processes/dispatcher'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  effectiveBuildConfigContent,
} from '../processes/build-execution-state'
import { MemoryBuildStore } from '../store/memory'
import { detailFromFacts, projectBuildDecision } from '../cli/status'
import { readBuildFacts } from '../store/reduced-reads'
import { manualClock } from '../testing/fixed'

const REPO = '/repos/origin'
const SLUG = 'docs-change'
const TICKET = 'T-docs'
const sha = (c: string) => c.repeat(40)
const BASE = sha('a')
const PR_HEAD = sha('b')

const PIPELINE = `
[commands]
test = "bun test"

[verify]
steps = ["unit"]

[verify.unit]
kind = "check"
command = "test"

[tickets]
source = "file"
readyState = "Ready"
`
const PROTECTED = `
[[merge]]
paths = ["autobuild.toml", "docs/policy/**"]
mode = "consent"

[[merge]]
within = ["docs/**", "README.md"]
mode = "auto"

[[merge]]
mode = "consent"
`
const CONFIG = parseConfig(`${PIPELINE}${PROTECTED}`)

function harness(config: Config = CONFIG) {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  const tickets = new FakeTicketSource([])
  const forge = new FakeForge({})
  forge.seedBranch('main', BASE)
  let target = BASE
  const dispatcherFor = (config: Config) =>
    new Dispatcher({
      store,
      tickets,
      workspaces: new FakeWorkspaceProvider({
        root: '/ws',
        mode: 'logical',
        base: { source: 'remote', sha: BASE },
      }),
      forge,
      config,
      repo: REPO,
      exec: async () => ({
        stdout: `${target}\trefs/heads/main\n`,
        stderr: '',
        exitCode: 0,
      }),
      launchRunner: async () => 'scheduled',
      ids: sequentialIds(),
      clock,
    })
  let dispatcher = dispatcherFor(config)
  const append = <T extends EventType>(type: T, payload: EventPayload<T>, actor: Actor = KERNEL) =>
    store.append(SLUG, { actor, type, payload } as EventWrite)
  const moveTarget = async (to: string) => {
    target = to
    forge.seedBranch('main', to)
    await append('target.moved', { branch: 'main', sha: to }, DISPATCHER)
  }
  const decide = async (): Promise<Decision> => {
    const facts = (await readBuildFacts(store, SLUG)).value
    return decideNextFromFacts(facts.state, facts.log, config)
  }
  const tick = () => dispatcher.tick({ acceptNewWork: false })
  const events = () => store.getEvents(SLUG)
  const reconfigure = (next: Config) => {
    dispatcher = dispatcherFor(next)
  }
  return {
    clock,
    store,
    tickets,
    forge,
    append,
    moveTarget,
    decide,
    tick,
    events,
    reconfigure,
  }
}
type Harness = ReturnType<typeof harness>

async function seed(h: Harness) {
  await h.tickets.create({ title: SLUG, body: 'body', labels: [] }, { requestedId: TICKET })
  const ticket = { source: 'fake', id: TICKET, title: SLUG }
  await h.store.createBuild({
    slug: SLUG,
    repo: REPO,
    ticket,
    branch: `ab/${SLUG}`,
  })
  await h.append('build.created', { ticket, repo: REPO, baseBranch: 'main' }, DISPATCHER)
  await h.append(
    'workspace.provisioned',
    {
      provider: 'fake',
      ref: `/ws/ab/${SLUG}`,
      branch: `ab/${SLUG}`,
      base: { source: 'remote', sha: BASE },
    },
    DISPATCHER,
  )
  await h.append('spec.imported', { artifact: { kind: 'spec', rev: 0 }, ticket }, DISPATCHER)
  await h.append('target.moved', { branch: 'main', sha: BASE }, DISPATCHER)
  await h.append('runner.attached', { instance: 'runner-1', host: 'local' })
  for (const [phase, verdict] of [
    ['plan', undefined],
    ['plan-review', 'approve'],
    ['implement', undefined],
    ['code-review', 'approve'],
  ] as const) {
    await h.append(`${phase}.started` as 'plan.started', { round: 1 })
    const actor = agentActor(phase, `s_${phase}`)
    if (phase === 'plan')
      await h.append('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }, actor)
    else if (phase === 'implement')
      await h.append(
        'implement.completed',
        {
          round: 1,
          commits: { base: BASE, head: PR_HEAD },
          artifact: { kind: 'implement-notes', rev: 0 },
        },
        actor,
      )
    else
      await h.append(
        `${phase}.verdict` as 'plan-review.verdict',
        {
          round: 1,
          verdict: verdict!,
          findings: [],
          artifact: { kind: phase, rev: 0 },
        },
        actor,
      )
  }
}

let shaCounter = 0
function nextSha(): string {
  shaCounter += 1
  return shaCounter.toString(16).padStart(40, 'e')
}

/** Append what the engine asks for until it parks the leaf: clean restacks
 * onto the observed target and passing checks. */
async function drive(h: Harness): Promise<Decision> {
  for (let guard = 0; guard < 40; guard++) {
    const decision = await h.decide()
    const facts = (await readBuildFacts(h.store, SLUG)).value
    switch (decision.kind) {
      case 'restack': {
        const head = facts.state.pr?.headSha ?? PR_HEAD
        const targetBase = facts.log.restack.target?.sha ?? BASE
        const transaction = {
          id: `restack-${guard}-${decision.cycle}`,
          trigger: decision.trigger,
          cycle: decision.cycle,
          observation: facts.log.restack.target?.seq ?? 1,
          branch: `ab/${SLUG}`,
          oldHead: head,
          oldBase: facts.log.restack.completed?.targetBase ?? BASE,
          targetBase,
          changeSha: head,
          workspaceHead: head,
          localBranchHead: head,
          message: 'Leaf change\n',
        }
        const headSha = targetBase === transaction.oldBase ? head : nextSha()
        await h.append('restack.prepared', transaction)
        await h.append('restack.replayed', {
          id: transaction.id,
          conflicted: false,
        })
        await h.append('restack.publish-intended', { ...transaction, headSha })
        await h.append('restack.rewritten', {
          ...transaction,
          headSha,
          archives: [],
        })
        await h.append('restack.completed', { ...transaction, headSha })
        break
      }
      case 'run-verify-stage':
        for (const member of decision.members) await pass(h, member.step, member.attempt)
        break
      case 'run-check':
      case 'run-agent-verify':
      case 'evaluate-verify':
        await pass(h, decision.step, decision.attempt)
        break
      default:
        return decision
    }
  }
  throw new Error('engine did not park')
}

async function pass(h: Harness, step: string, attempt: number) {
  await h.append('verify.started', { step, attempt })
  await h.append('verify.completed', { step, attempt, outcome: 'pass' })
}

/** The producing build's deposit of a head's changed paths. */
async function recordPaths(h: Harness, head: string, paths: string[]) {
  const { artifacts, makeEvent } = headPathsWrite(
    {
      version: 1,
      head,
      destination: BASE,
      mergeBase: BASE,
      paths: [...paths].sort(),
    },
    'restack',
    KERNEL,
  )
  await h.store.appendWithArtifacts(SLUG, artifacts, makeEvent)
}

/** A green leaf with an open, mergeable PR parked at awaiting-pr. */
async function greenLeaf(h: Harness, paths?: string[]) {
  await seed(h)
  await h.store.putArtifact(SLUG, {
    kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
    content: effectiveBuildConfigContent(CONFIG),
  })
  expect(await drive(h)).toMatchObject({
    kind: 'run-phase',
    phase: 'finalize',
  })
  await h.append('finalize.started', {})
  if (paths) await recordPaths(h, PR_HEAD, paths)
  await h.append('finalize.completed', {
    pr: { number: 1, url: 'https://fake.forge/pr/1', headSha: PR_HEAD },
  })
  expect(await drive(h)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
  h.forge.setPrState(1, { state: 'open', mergeable: true })
}

const ofType = async <T extends EventType>(h: Harness, type: T) =>
  (await h.events()).flatMap((e) => (e.type === type ? [e.payload as EventPayload<T>] : []))

const statusOf = async (h: Harness) => {
  const facts = (await readBuildFacts(h.store, SLUG)).value
  const decision = await projectBuildDecision(SLUG, facts, h.store)
  const record = (await h.store.getBuild(SLUG))!
  return {
    facts,
    detail: detailFromFacts(record, facts, h.clock(), undefined, decision),
  }
}

describe('merge rules match the paths a candidate head changes', () => {
  test('a docs-only head merges automatically; a new head touching policy waits for consent', async () => {
    const h = harness()
    await greenLeaf(h, ['README.md', 'docs/guide.md'])
    await h.tick()
    let decided = await ofType(h, 'landing.decided')
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({
      candidate: { head: PR_HEAD },
      mode: 'auto',
      rule: {
        index: 1,
        snapshot: { within: ['docs/**', 'README.md'], mode: 'auto' },
      },
      paths: { total: 2, preview: ['README.md', 'docs/guide.md'] },
    })
    expect(await h.forge.getPrState('/ws', 1)).toMatchObject({
      nativeAutoMerge: true,
    })

    // A later head edits autobuild.toml. Its publication suspends the native
    // merge armed for the old decision before the head moves.
    await suspendNativeLanding(
      {
        store: h.store,
        forge: h.forge,
        slug: SLUG,
        workspacePath: `/ws/ab/${SLUG}`,
      },
      'restack-policy',
    )
    expect(await h.forge.getPrState('/ws', 1)).toMatchObject({
      nativeAutoMerge: false,
    })
    await h.moveTarget(sha('c'))
    expect(await drive(h)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
    const head = (await readBuildFacts(h.store, SLUG)).value.state.pr!.headSha
    expect(head).not.toBe(PR_HEAD)
    await recordPaths(h, head, ['autobuild.toml', 'docs/guide.md'])
    await h.tick()

    decided = await ofType(h, 'landing.decided')
    expect(decided).toHaveLength(2)
    expect(decided[1]).toMatchObject({
      candidate: { head },
      mode: 'consent',
      rule: { index: 0 },
      paths: { total: 1, preview: ['autobuild.toml'] },
    })
    expect(await h.forge.getPrState('/ws', 1)).toMatchObject({
      state: 'open',
      nativeAutoMerge: false,
    })
    expect(h.forge.squashMergeCalls).toHaveLength(0)
    expect(h.forge.autoMergeCalls.filter((c) => c.enabled)).toHaveLength(1)
    const { facts } = await statusOf(h)
    expect(facts.state.landing?.decision?.mode).toBe('consent')
    expect(landRefusalReason(facts.state, facts.log.restack)).toBeUndefined()
  })

  test('an unrecorded head defers once, costs nothing per poll, and re-evaluates on a policy edit', async () => {
    const h = harness()
    await greenLeaf(h)
    await h.tick()
    expect(await ofType(h, 'landing.decided')).toHaveLength(0)
    const deferred = await ofType(h, 'landing.deferred')
    expect(deferred).toHaveLength(1)
    expect(deferred[0]).toMatchObject({
      candidate: { head: PR_HEAD },
      reason: 'paths-unrecorded',
      rule: { index: 0 },
    })
    const { detail } = await statusOf(h)
    expect(detail.landingUndecided).toStartWith(
      `deferred — [[merge]] rule merge[0] matches on changed paths, but the changed paths of head ${PR_HEAD.slice(0, 12)} are not recorded`,
    )
    expect(await h.forge.getPrState('/ws', 1)).toMatchObject({
      nativeAutoMerge: false,
    })

    const before = (await h.events()).length
    const gets: string[] = []
    const get = h.tickets.get.bind(h.tickets)
    h.tickets.get = async (id) => {
      gets.push(id)
      return get(id)
    }
    await h.tick()
    const perPoll = gets.length
    await h.tick()
    expect((await h.events()).length).toBe(before)
    expect(gets.length).toBe(2 * perPoll)

    // A policy without path rules decides the same candidate once: one more
    // ticket read than a deferred poll, then decided polls cost the same.
    h.reconfigure(parseConfig(`${PIPELINE}\n[[merge]]\nmode = "consent"\n`))
    await h.tick()
    expect(gets.length).toBe(3 * perPoll + 1)
    expect(await ofType(h, 'landing.decided')).toMatchObject([
      { candidate: { head: PR_HEAD }, mode: 'consent', rule: { index: 0 } },
    ])
    await h.tick()
    expect(gets.length).toBe(4 * perPoll + 1)
    expect((await statusOf(h)).facts.state.landing?.deferral).toBeUndefined()
  })

  test('a head beyond the recorded preview reads its complete paths once, at decision time', async () => {
    const h = harness()
    const paths = [
      ...Array.from({ length: 149 }, (_, i) => `docs/${String(i).padStart(3, '0')}.md`),
      'src/z.ts',
    ]
    await greenLeaf(h, paths)
    const getArtifact = h.store.getArtifact.bind(h.store)
    const reads: string[] = []
    h.store.getArtifact = async (slug, kind, rev) => {
      reads.push(kind)
      return getArtifact(slug, kind, rev)
    }
    await h.tick()
    // `src/z.ts` sits beyond the 100-path preview: `within` must not match.
    expect(await ofType(h, 'landing.decided')).toMatchObject([
      { mode: 'consent', rule: { index: 2 } },
    ])
    expect(reads.filter((kind) => kind === HEAD_PATHS_ARTIFACT)).toHaveLength(1)
    await h.tick()
    await h.tick()
    expect(reads.filter((kind) => kind === HEAD_PATHS_ARTIFACT)).toHaveLength(1)
  })
})

/** A replacement head produced by a resolver (reconcile) or a clean restack:
 * the kernel records its paths, and a reconcile's resolution decides
 * revocation exactly as `ab done` for reconcile does. */
async function replaceHead(
  h: Harness,
  source: 'reconcile' | 'restack',
  paths: string[],
  resolution?: string[],
) {
  const previous = (await readBuildFacts(h.store, SLUG)).value.state.pr!.headSha
  await h.moveTarget(nextSha())
  expect(await drive(h)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
  const head = (await readBuildFacts(h.store, SLUG)).value.state.pr!.headSha
  expect(head).not.toBe(previous)
  const { artifacts, makeEvent } = headPathsWrite(
    {
      version: 1,
      head,
      destination: BASE,
      mergeBase: BASE,
      paths: [...paths].sort(),
      ...(resolution === undefined ? {} : { resolution: { paths: [...resolution].sort() } }),
    },
    source,
    KERNEL,
  )
  await h.store.appendWithArtifacts(SLUG, artifacts, makeEvent)
  const revocation = consentRevocation((await readBuildFacts(h.store, SLUG)).value.state.landing, {
    source: 'reconcile',
    previousHead: previous,
    head,
    resolution: resolution ?? [],
  })
  if (revocation) await h.append('landing.consent-revoked', revocation)
  return { previous, head }
}

const consent = async (h: Harness) => {
  const decision = (await readBuildFacts(h.store, SLUG)).value.state.landing!.decision!
  await h.append('build.land-requested', { decisionSeq: decision.seq }, humanActor('operator'))
}
const nativeEnables = (h: Harness) => h.forge.autoMergeCalls.filter((c) => c.enabled).length

describe('protected consent and reconcile edits (GitHub #942)', () => {
  /** A protected head decided as consent, consented, and not yet applied. */
  async function consented(config: Config = CONFIG) {
    const h = harness(config)
    await greenLeaf(h, ['autobuild.toml'])
    await h.tick()
    expect(await ofType(h, 'landing.decided')).toMatchObject([{ mode: 'consent' }])
    expect(nativeEnables(h)).toBe(0)
    await consent(h)
    return h
  }

  test('a reconcile editing a protected file revokes consent until fresh consent', async () => {
    const h = await consented()
    const { previous, head } = await replaceHead(
      h,
      'reconcile',
      ['autobuild.toml', 'src/x.ts'],
      ['autobuild.toml', 'src/x.ts'],
    )
    expect(await ofType(h, 'landing.consent-revoked')).toMatchObject([
      {
        source: 'reconcile',
        rule: { index: 0 },
        previousHead: previous,
        head,
        consentedHead: PR_HEAD,
        paths: { total: 1, preview: ['autobuild.toml'] },
      },
    ])
    await h.tick()
    expect(await ofType(h, 'landing.decided')).toMatchObject([
      { mode: 'consent' },
      { candidate: { head }, mode: 'consent', rule: { index: 0 } },
    ])
    expect(nativeEnables(h)).toBe(0)
    let { facts } = await statusOf(h)
    expect(facts.state.landing?.command).toBeUndefined()
    expect(awaitsConsent(facts.state, facts.log.restack)).toBe(true)

    await consent(h)
    await h.tick()
    expect(nativeEnables(h)).toBe(1)
    ;({ facts } = await statusOf(h))
    expect(facts.state.landing?.command).toMatchObject({ kind: 'land', head })
  })

  for (const item of [
    { name: 'a clean restack', source: 'restack' as const, resolution: undefined },
    {
      name: 'a reconcile editing only unprotected files',
      source: 'reconcile' as const,
      resolution: ['src/x.ts'],
    },
  ])
    test(`consent survives ${item.name}`, async () => {
      const h = await consented()
      await replaceHead(h, item.source, ['autobuild.toml', 'src/x.ts'], item.resolution)
      expect(await ofType(h, 'landing.consent-revoked')).toHaveLength(0)
      await h.tick()
      expect(await ofType(h, 'landing.decided')).toHaveLength(2)
      expect(nativeEnables(h)).toBe(1)
    })

  test('consent under a rule without path predicates survives any reconcile', async () => {
    const h = await consented(parseConfig(`${PIPELINE}\n[[merge]]\nmode = "consent"\n`))
    await replaceHead(h, 'reconcile', ['autobuild.toml'], ['autobuild.toml'])
    expect(await ofType(h, 'landing.consent-revoked')).toHaveLength(0)
    await h.tick()
    expect(nativeEnables(h)).toBe(1)
  })
})
