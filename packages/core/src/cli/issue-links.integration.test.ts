/**
 * Forge issue links through a build (SPEC "Forge issue links"): the one-way
 * `ab issue downgrade` command, the finalize seal that closes its window
 * before the first PR side effect, and PR composition by a capable forge.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope, EventWrite } from '../events/catalog'
import { agentActor, KERNEL } from '../events/envelope'
import type { EventType } from '../events/payloads'
import { reduceBuild } from '../kernel/reducer'
import { FakeForge } from '../ports/forge/fake'
import type { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import { buildContext } from './context'
import { downgradeIssueLink } from './issue-links'
import { runCli } from './main'
import { detail, renderDetail } from './status'
import { completeFinalizePr, done } from './terminals'
import { BRANCH, BUILD, initWorkspaceRepo, makeDeps, makeEnv, runGit, seedStore } from './testkit'

const LINKS = [
  { issue: 820, intent: 'closes' as const },
  { issue: 824, intent: 'closes' as const },
]

let tmp: string
let store: MemoryBuildStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-issue-links-'))
  store = await seedStore({ issueLinks: LINKS })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
  await store.close()
})

const implementEnv = makeEnv({ phase: 'implement' })

async function types(): Promise<string[]> {
  return (await store.getEvents(BUILD)).map((event) => event.type)
}

async function state() {
  return reduceBuild(await store.getEvents(BUILD))
}

describe('ab issue downgrade', () => {
  test('records a one-way downgrade with its reason', async () => {
    const event = await downgradeIssueLink(
      { store, env: implementEnv },
      { issue: '#824', reason: '  only the API half  ' },
    )
    expect(event.payload).toEqual({ issue: 824, reason: 'only the API half' })
    expect(event.actor).toEqual(agentActor('implement', 's_test'))
    expect((await state()).issueLinks).toEqual([
      { issue: 820, intent: 'closes' },
      { issue: 824, intent: 'refs', downgrade: { reason: 'only the API half', seq: event.seq } },
    ])
  })

  test('refuses without appending anything', async () => {
    const before = await types()
    const deps = { store, env: implementEnv }
    await expect(downgradeIssueLink(deps, { issue: '824', reason: ' ' })).rejects.toThrow(
      /requires a non-empty --reason/,
    )
    await expect(downgradeIssueLink(deps, { issue: 'abc', reason: 'r' })).rejects.toThrow(
      /expects an issue number/,
    )
    await expect(downgradeIssueLink(deps, { issue: '9', reason: 'r' })).rejects.toThrow(
      /#9 is not linked; linked: closes #820, closes #824/,
    )
    expect(await types()).toEqual(before)

    await downgradeIssueLink(deps, { issue: '824', reason: 'partial' })
    const downgraded = await types()
    await expect(downgradeIssueLink(deps, { issue: '824', reason: 'again' })).rejects.toThrow(
      /already refs/,
    )
    expect(await types()).toEqual(downgraded)

    await store.append(BUILD, { actor: KERNEL, type: 'issue-links.sealed', payload: {} })
    const sealed = await types()
    await expect(downgradeIssueLink(deps, { issue: '820', reason: 'late' })).rejects.toThrow(
      /sealed when the PR was prepared at seq \d+; use 'ab escalate'/,
    )
    expect(await types()).toEqual(sealed)
  })

  test('a seal that overtakes the append makes the command fail, not succeed', async () => {
    // The seal lands between the command's read and its append.
    const racing = Object.create(store) as MemoryBuildStore
    racing.append = async <T extends EventType>(
      slug: string,
      event: EventWrite<T>,
    ): Promise<EventEnvelope<T>> => {
      if (event.type === 'issue-link.downgraded')
        await store.append(slug, { actor: KERNEL, type: 'issue-links.sealed', payload: {} })
      return store.append(slug, event)
    }
    await expect(
      downgradeIssueLink({ store: racing, env: implementEnv }, { issue: '824', reason: 'late' }),
    ).rejects.toThrow(/downgrade recorded at seq \d+ but inert: links were sealed at seq \d+/)
    expect((await state()).issueLinks[1]).toEqual({ issue: 824, intent: 'closes' })
  })

  test('routes through the CLI with a usage error otherwise', async () => {
    const out: string[] = []
    const err: string[] = []
    const deps = { ...makeDeps({ store, env: implementEnv }), stdout: out.push.bind(out) }
    const cli = { ...deps, stderr: err.push.bind(err) }
    expect(await runCli(['issue', 'downgrade', '824', '--reason', 'API half only'], cli)).toBe(0)
    expect(out.at(-1)).toMatch(/^issue #824 downgraded to refs \(seq \d+\)$/)
    expect(await runCli(['issue', 'upgrade', '824'], cli)).toBe(1)
    expect(await runCli(['issue', 'downgrade', '820'], cli)).toBe(1)
    expect(err.join('\n')).toContain('usage: ab issue downgrade <N> --reason <text>')
    expect(err.join('\n')).toContain("'ab issue downgrade' requires --reason <text>")
  })

  test('status and context show the links and the downgrade', async () => {
    await downgradeIssueLink({ store, env: implementEnv }, { issue: '824', reason: 'API half' })
    const now = new Date()
    const shown = detail((await store.getBuild(BUILD))!, await store.getEvents(BUILD), now)
    expect(shown.issueLinksSealed).toBe(false)
    expect(renderDetail(shown, now)).toContain(
      '  issues:   closes #820, refs #824 (downgraded from closes: API half)',
    )

    const workspace = join(tmp, 'ws-context')
    await initWorkspaceRepo(workspace)
    const manifest = await buildContext(
      makeDeps({ store, env: makeEnv({ phase: 'finalize' }), workspacePath: workspace }),
    )
    expect(manifest.issueLinks).toEqual([
      { issue: 820, intent: 'closes' },
      { issue: 824, intent: 'refs', downgradeReason: 'API half' },
    ])
  })
})

describe('finalize seals and composes issue links', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = join(tmp, 'ws-finalize')
    await initWorkspaceRepo(workspace)
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Fixes #824: cache the API\n\nThis fixes #824 by caching.\n',
    })
  })

  const finalizeDeps = (forge: FakeForge, target: BuildStore = store) => ({
    ...makeDeps({ store, env: makeEnv({ phase: 'finalize' }), workspacePath: workspace, forge }),
    store: target,
  })

  test('a capable forge gets neutralized title and keyword-ending body', async () => {
    await downgradeIssueLink({ store, env: implementEnv }, { issue: '824', reason: 'API half' })
    const forge = new FakeForge({ closesIssues: true })
    await done(finalizeDeps(forge))

    expect(forge.opened).toHaveLength(1)
    expect(forge.opened[0]!.title).toBe('Refs #824: cache the API')
    expect(forge.opened[0]!.body).toBe('This refs #824 by caching.\n\nCloses #820\nRefs #824\n')
    const order = await types()
    expect(order.indexOf('issue-links.sealed')).toBeGreaterThan(
      order.indexOf('issue-link.downgraded'),
    )
    expect(order.indexOf('issue-links.sealed')).toBeLessThan(order.indexOf('finalize.completed'))
  })

  test('a downgrade after the seal but before openPr is inert', async () => {
    const forge = new FakeForge({ closesIssues: true })
    const openPr = forge.openPr.bind(forge)
    forge.openPr = async (opts) => {
      await store.append(BUILD, {
        actor: agentActor('finalize', 's_test'),
        type: 'issue-link.downgraded',
        payload: { issue: 824, reason: 'too late' },
      })
      return openPr(opts)
    }
    await done(finalizeDeps(forge))
    expect(forge.opened[0]!.body).toEndWith('Closes #820\nCloses #824\n')
    expect((await state()).issueLinks[1]).toEqual({ issue: 824, intent: 'closes' })
  })

  test('a retry after a lost finalize.completed reseals nothing and composes the same links', async () => {
    const forge = new FakeForge({ closesIssues: true })
    const requested: unknown[] = []
    const openPr = forge.openPr.bind(forge)
    forge.openPr = async (opts) => {
      requested.push(opts.issueLinks)
      return openPr(opts)
    }
    const failing = Object.create(store) as MemoryBuildStore
    let fail = true
    failing.appendWithArtifactsIfCurrent = (async (slug, cursor, artifacts, make) => {
      if (fail && make([]).type === 'finalize.completed') {
        fail = false
        throw new Error('injected append failure')
      }
      return store.appendWithArtifactsIfCurrent(slug, cursor, artifacts, make)
    }) as MemoryBuildStore['appendWithArtifactsIfCurrent']

    await expect(done(finalizeDeps(forge, failing))).rejects.toThrow(/injected append failure/)
    await done(finalizeDeps(forge, failing))

    expect((await types()).filter((type) => type === 'issue-links.sealed')).toHaveLength(1)
    expect(requested).toHaveLength(2)
    expect(requested[1]).toEqual(requested[0])
    expect(forge.opened).toHaveLength(1)
  })

  test('remote finalize is sealed by its publication request', async () => {
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'workspace.provisioned',
      payload: {
        provider: 'vercel-sandbox',
        ref: 'sandbox-finalize',
        path: '/vercel/sandbox/workspace',
        branch: BRANCH,
        base: { source: 'existing', sha: 'a'.repeat(40) },
      },
    })
    const forge = new FakeForge({ closesIssues: true })
    const deps = finalizeDeps(forge)
    const request = await done(deps)
    expect(request.type).toBe('publication.requested')
    expect((await state()).issueLinksSealedSeq).toBe(request.seq)
    await expect(
      downgradeIssueLink({ store, env: implementEnv }, { issue: '824', reason: 'late' }),
    ).rejects.toThrow(/sealed/)

    const head = await runGit(['rev-parse', 'HEAD'], workspace)
    forge.setHeadSha(head)
    await completeFinalizePr(deps, (await readBuildFacts(store, BUILD)).value, {
      branch: BRANCH,
      baseBranch: 'main',
      title: 'Fixes #824: cache the API',
      body: 'This fixes #824 by caching.\n',
      mergeMessage: '',
      expectedHeadSha: head,
    })
    expect(await types()).not.toContain('issue-links.sealed')
    expect(forge.opened[0]!.body).toEndWith('Closes #820\nCloses #824\n')
  })

  test('a forge without the capability records links but writes no keywords', async () => {
    const forge = new FakeForge()
    let passed: unknown = 'unset'
    const openPr = forge.openPr.bind(forge)
    forge.openPr = async (opts) => {
      passed = opts.issueLinks
      return openPr(opts)
    }
    await done(finalizeDeps(forge))
    expect(passed).toBeUndefined()
    expect(forge.opened[0]!.title).toBe('Fixes #824: cache the API')
    expect(forge.opened[0]!.body).toBe('This fixes #824 by caching.\n')
    expect((await state()).issueLinks).toEqual(LINKS)
  })

  async function seedNodeTargetLeaf() {
    await store.close()
    store = await seedStore({
      issueLinks: LINKS,
      target: { ticket: { source: 'linear', id: 'ENG-1' }, build: 'site-node' },
      baseBranch: 'ab-node/site',
    })
    await store.putArtifact(BUILD, {
      kind: 'pr-description',
      content: '# Title\n\nfixes #824 here\n',
    })
  }

  test('a leaf aimed at a node writes refs-only lines into its PR', async () => {
    await seedNodeTargetLeaf()
    const forge = new FakeForge({ closesIssues: true })
    await done(finalizeDeps(forge))
    expect(forge.opened[0]).toMatchObject({
      base: 'ab-node/site',
      body: 'refs #824 here\n\nRefs #820\nRefs #824\n',
    })
  })

  test('re-finalizing a node-target leaf converges an adopted PR without duplicating lines', async () => {
    await seedNodeTargetLeaf()
    const forge = new FakeForge({ closesIssues: true })
    const head = await runGit(['rev-parse', 'HEAD'], workspace)
    forge.setHeadSha(head)
    await forge.openPr({
      workspacePath: workspace,
      head: BRANCH,
      base: 'ab-node/site',
      title: 'Fix #820',
      body: 'x\n\nCloses #820',
    })
    const failing = Object.create(store) as MemoryBuildStore
    let fail = true
    failing.appendWithArtifactsIfCurrent = (async (slug, cursor, artifacts, make) => {
      if (fail && make([]).type === 'finalize.completed') {
        fail = false
        throw new Error('injected append failure')
      }
      return store.appendWithArtifactsIfCurrent(slug, cursor, artifacts, make)
    }) as MemoryBuildStore['appendWithArtifactsIfCurrent']

    await expect(done(finalizeDeps(forge, failing))).rejects.toThrow(/injected append failure/)
    expect(forge.opened).toHaveLength(1)
    expect(forge.opened[0]).toMatchObject({ title: 'Refs #820', body: 'x\n\nRefs #820\nRefs #824' })
    const refsOnly = [
      { issue: 820, intent: 'refs' as const },
      { issue: 824, intent: 'refs' as const },
    ]
    expect(forge.issueLinkAdoptions).toEqual([{ number: 1, issueLinks: refsOnly }])

    await done(finalizeDeps(forge, failing))
    expect(forge.opened).toHaveLength(1)
    expect(forge.opened[0]).toMatchObject({ title: 'Refs #820', body: 'x\n\nRefs #820\nRefs #824' })
    expect(forge.issueLinkAdoptions).toHaveLength(2)
  })

  test('a build without links appends no seal', async () => {
    await store.close()
    store = await seedStore()
    await store.putArtifact(BUILD, { kind: 'pr-description', content: '# Title\n\nBody.\n' })
    const forge = new FakeForge({ closesIssues: true })
    await done(finalizeDeps(forge))
    expect(await types()).not.toContain('issue-links.sealed')
    expect(forge.opened[0]!.body).toBe('Body.\n')
  })
})
