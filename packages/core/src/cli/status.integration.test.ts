import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../config/load'
import { autoMergeDeferralObservation } from '../kernel/auto-merge'
import { normalizeGitRemoteUrl } from '../kernel/origin'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  effectiveBuildConfigContent,
} from '../processes/build-execution-state'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { PhaseSessionError } from '../store/phase-session'
import type { BuildDigest, BuildRecord, BuildStore } from '../store/types'
import { steppingClock } from '../testing/fixed'
import {
  abBuildAssetGet,
  abBuildStatus,
  abBuilds,
  detail,
  renderDetail,
  renderSummaries,
  statusFilter,
  summarize,
  type BuildSummary,
} from './status'
import { describeStoreOpeningContract } from './store-opening.contract'

const NOW = new Date('2026-07-15T12:00:00.000Z')
const REPO = '/Users/dev/code/acme-app'
const OTHER_REPO = '/Users/dev/code/other-app'
const fakeExec: Exec = async (cmd) =>
  cmd[1] === 'remote'
    ? // No origin remote: identity falls back to the resolved checkout path.
      { stdout: '', stderr: "error: No such remote 'origin'\n", exitCode: 2 }
    : {
        stdout: `${REPO}/.git\n${REPO}/.git\n${REPO}\n`,
        stderr: '',
        exitCode: 0,
      }

/** An exec standing in for a differently located checkout (a sandbox guest):
 * rev-parse resolves to `guestRepo`, and the origin remote answers `origin`. */
function guestExec(guestRepo: string, origin: string): Exec {
  return async (cmd) =>
    cmd[1] === 'remote'
      ? { stdout: `${origin}\n`, stderr: '', exitCode: 0 }
      : { stdout: `${guestRepo}/.git\n${guestRepo}/.git\n${guestRepo}\n`, stderr: '', exitCode: 0 }
}

/** A store seeded with one build per spec; each gets its own event log. */
async function seedBuild(
  store: MemoryBuildStore,
  opts: {
    slug: string
    repo?: string
    status?: 'queued' | 'running' | 'blocked' | 'paused' | 'done'
  },
): Promise<void> {
  await store.createBuild({
    slug: opts.slug,
    repo: opts.repo ?? REPO,
    ticket: { source: 'linear', id: 'ENG-1', title: 'A ticket' },
  })
  const status = opts.status ?? 'running'
  if (status === 'queued') return
  await store.append(opts.slug, {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
  if (status === 'blocked') {
    await store.append(opts.slug, {
      actor: agentActor('implement', 's_1'),
      type: 'escalation.raised',
      payload: {
        id: 'esc_1',
        phase: 'implement',
        round: 1,
        source: 'agent',
        question: 'Which auth store?',
      },
    })
  }
  if (status === 'paused') {
    // The human emits build.pause-requested; build.paused is the kernel's
    // acknowledging fact event (D2), and that fact is what reduces to 'paused'.
    await store.append(opts.slug, {
      actor: humanActor('dev'),
      type: 'build.pause-requested',
      payload: {},
    })
    await store.append(opts.slug, {
      actor: KERNEL,
      type: 'build.paused',
      payload: {},
    })
  }
  if (status === 'done') {
    // build.completed is dispatcher-authored (see allowedActorKinds).
    await store.append(opts.slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }
}

async function seedAwaitingPr(
  store: MemoryBuildStore,
  workspace: string,
  detail?: string,
  refOnly = false,
  noCommand = false,
): Promise<void> {
  await seedBuild(store, { slug: 'merge-wait' })
  await store.append('merge-wait', {
    actor: DISPATCHER,
    type: 'workspace.provisioned',
    payload: {
      provider: 'test',
      ref: workspace,
      ...(refOnly ? {} : { path: workspace }),
      branch: 'ab/merge-wait',
      base: { source: 'remote', sha: 'base' },
    },
  })
  await store.append('merge-wait', {
    actor: DISPATCHER,
    type: 'spec.imported',
    payload: { artifact: { kind: 'spec', rev: 0 }, ticket: { source: 'linear', id: 'ENG-1' } },
  })
  await store.append('merge-wait', { actor: KERNEL, type: 'plan.started', payload: { round: 1 } })
  await store.append('merge-wait', {
    actor: agentActor('plan', 's_plan'),
    type: 'plan.completed',
    payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
  })
  await store.append('merge-wait', {
    actor: KERNEL,
    type: 'plan-review.started',
    payload: { round: 1 },
  })
  await store.append('merge-wait', {
    actor: agentActor('plan-review', 's_plan_review'),
    type: 'plan-review.verdict',
    payload: {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'plan-review', rev: 0 },
    },
  })
  await store.append('merge-wait', {
    actor: KERNEL,
    type: 'implement.started',
    payload: { round: 1 },
  })
  await store.append('merge-wait', {
    actor: agentActor('implement', 's_implement'),
    type: 'implement.completed',
    payload: {
      round: 1,
      commits: { base: 'base', head: 'head' },
      artifact: { kind: 'implement-notes', rev: 0 },
    },
  })
  await store.append('merge-wait', {
    actor: KERNEL,
    type: 'code-review.started',
    payload: { round: 1 },
  })
  await store.append('merge-wait', {
    actor: agentActor('code-review', 's_code_review'),
    type: 'code-review.verdict',
    payload: {
      round: 1,
      verdict: 'approve',
      findings: [],
      artifact: { kind: 'code-review', rev: 0 },
    },
  })
  await store.append('merge-wait', { actor: KERNEL, type: 'finalize.started', payload: {} })
  await store.append('merge-wait', {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 7, url: 'https://example.test/pull/7', headSha: 'head' } },
  })
  // `noCommand` seeds the bare parked build — no consent anywhere in the log —
  // which is the state whose wait line must name the missing consent.
  const command = noCommand
    ? undefined
    : await store.append('merge-wait', {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: {},
      })
  if (detail !== undefined) {
    await store.append(
      'merge-wait',
      autoMergeDeferralObservation(
        { code: 'local-base-checkout-dirty', detail },
        7,
        command?.seq ?? 1,
        'obs_merge_wait',
      ),
    )
  }
}

const MINIMAL_CONFIG = '[tickets]\nsource = "file"\nreadyState = "ready"\n'

describe('abBuilds', () => {
  async function run(
    store: MemoryBuildStore,
    opts: { queued?: boolean; all?: boolean; json?: boolean } = {},
  ): Promise<string[]> {
    const out: string[] = []
    await abBuilds({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => out.push(line),
      openStore: () => store,
      now: () => NOW,
      ...opts,
    })
    return out
  }

  test("lists only the current repo's builds", async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'mine', repo: REPO })
    await seedBuild(store, { slug: 'theirs', repo: OTHER_REPO })
    const text = (await run(store)).join('\n')
    expect(text).toContain('mine')
    expect(text).not.toContain('theirs')
  })

  test('default selection is running/paused/blocked', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-running', status: 'running' })
    await seedBuild(store, { slug: 'is-blocked', status: 'blocked' })
    await seedBuild(store, { slug: 'is-paused', status: 'paused' })
    await seedBuild(store, { slug: 'is-queued', status: 'queued' })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store)).join('\n')
    expect(text).toContain('is-running')
    expect(text).toContain('is-blocked')
    expect(text).toContain('is-paused')
    expect(text).not.toContain('is-queued')
    expect(text).not.toContain('is-done')
  })

  test('--queued adds queued builds but not terminal ones', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-running', status: 'running' })
    await seedBuild(store, { slug: 'is-queued', status: 'queued' })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store, { queued: true })).join('\n')
    expect(text).toContain('is-queued')
    expect(text).toContain('is-running')
    expect(text).not.toContain('is-done')
  })

  test('--all includes every status', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-running', status: 'running' })
    await seedBuild(store, { slug: 'is-queued', status: 'queued' })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store, { all: true })).join('\n')
    expect(text).toContain('is-running')
    expect(text).toContain('is-queued')
    expect(text).toContain('is-done')
  })

  test('an empty result names the filter, and --all says so honestly', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store)).join('\n')
    expect(text).toContain('no active builds')
    expect(text).toContain('--queued or --all')
  })

  // The hint must suggest only flags that would actually widen what was asked
  // for — "try --queued" to someone who passed --queued reads as a bug.
  test('the empty hint under --queued suggests --all, not --queued again', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'is-done', status: 'done' })
    const text = (await run(store, { queued: true })).join('\n')
    expect(text).toContain('no active or queued builds')
    expect(text).toContain('--all')
    expect(text).not.toContain('--queued')
  })

  test('the empty hint under --all suggests nothing — there is nothing wider', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const text = (await run(store, { all: true })).join('\n')
    expect(text).toContain('no builds for')
    expect(text).not.toContain('try')
  })

  test('--json parses, matches the projection, and carries no ANSI', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const raw = (await run(store, { json: true })).join('\n')
    expect(raw).not.toContain('\x1b')
    const parsed = JSON.parse(raw)
    const expected = summarize((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(parsed).toEqual([JSON.parse(JSON.stringify(expected))])
  })
})

// AUT-488: the active and queued listings gate per-build history reads on one
// batch digest read, so their store cost stays flat as finished builds
// accumulate. The old algorithm is computed inline in each test so the output
// equivalence is pinned against the pre-change behavior, not against a
// re-derivation of the new gate.
test('ab builds, ab build status and ab repository status JSON report slot state with no event row (#1341)', async () => {
  const { openBuildListingReadBudget } = await import('../testing/reduced-read-budget')
  await openBuildListingReadBudget({ commands: true })
})

describe('abBuilds store cost (AUT-488)', () => {
  function countingStore(store: MemoryBuildStore): {
    store: BuildStore
    counts: Map<string, number>
    eventSlugs: string[]
  } {
    const counts = new Map<string, number>()
    const eventSlugs: string[] = []
    const target = store as unknown as Record<string, unknown>
    const proxy = new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol') return Reflect.get(t, prop, t)
        const value = t[prop]
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          counts.set(prop, (counts.get(prop) ?? 0) + 1)
          if (prop === 'getReducerValue') eventSlugs.push((args[0] as { slug: string }).slug)
          return (value as (...a: unknown[]) => unknown).apply(t, args)
        }
      },
    })
    return { store: proxy as unknown as BuildStore, counts, eventSlugs }
  }

  async function runCounting(
    store: BuildStore,
    opts: { queued?: boolean; all?: boolean; json?: boolean } = {},
  ): Promise<string[]> {
    const out: string[] = []
    await abBuilds({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => out.push(line),
      openStore: () => store,
      now: () => NOW,
      ...opts,
    })
    return out
  }

  async function seedFinished(
    store: MemoryBuildStore,
    slug: string,
    kind: 'done' | 'aborted',
  ): Promise<void> {
    await seedBuild(store, { slug, status: 'running' })
    if (kind === 'done') {
      // build.completed is dispatcher-authored (see allowedActorKinds).
      await store.append(slug, {
        actor: DISPATCHER,
        type: 'build.completed',
        payload: { outcome: 'merged' },
      })
    } else {
      await store.append(slug, { actor: KERNEL, type: 'build.aborted', payload: {} })
    }
  }

  /** The pre-change `abBuilds` selection, computed against the raw store.
   * fakeExec has no origin remote, so the identity is the checkout path. */
  async function legacySummaries(
    store: MemoryBuildStore,
    opts: { queued?: boolean; all?: boolean } = {},
  ): Promise<BuildSummary[]> {
    const wanted = new Set(statusFilter(opts.all, opts.queued))
    const mine = (record: BuildRecord): boolean =>
      record.repo === REPO ||
      (record.repoOrigin !== undefined && normalizeGitRemoteUrl(record.repoOrigin) === REPO)
    const summaries: BuildSummary[] = []
    for (const record of (await store.listBuilds()).filter(mine)) {
      const summary = summarize(record, await store.getEvents(record.slug), NOW)
      if (wanted.has(summary.status)) summaries.push(summary)
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  test('default and --queued scopes pay one digest read and skip finished histories', async () => {
    for (const finishedCount of [3, 8]) {
      const store = new MemoryBuildStore({ clock: steppingClock() })
      await seedBuild(store, { slug: 'run-1', status: 'running' })
      await seedBuild(store, { slug: 'run-2', status: 'blocked' })
      await seedBuild(store, { slug: 'is-queued', status: 'queued' })
      const finishedSlugs: string[] = []
      for (let i = 0; i < finishedCount; i++) {
        const slug = `finished-${i}`
        finishedSlugs.push(slug)
        // Alternate done and aborted so both terminal kinds are skipped.
        await seedFinished(store, slug, i % 2 === 0 ? 'done' : 'aborted')
      }
      for (const queued of [false, true] as const) {
        const counting = countingStore(store)
        const text = await runCounting(counting.store, queued ? { queued: true } : {})
        // The bound: exactly one digest read, and one history read per
        // non-terminal record — identical at both finished-build counts.
        expect(counting.counts.get('getRepoBuildDigests')).toBe(1)
        expect(counting.counts.get('getReducerValue')).toBe(3)
        for (const slug of finishedSlugs) expect(counting.eventSlugs).not.toContain(slug)
        // Output equivalence — rendered text and JSON against the old algorithm.
        const expected = await legacySummaries(store, { queued })
        const scope = queued ? 'active or queued builds' : 'active builds'
        const hint = queued ? ' — try --all' : ' — try --queued or --all'
        expect(text).toEqual(renderSummaries(expected, NOW, `no ${scope} for ${REPO}${hint}`))
        const jsonOut = await runCounting(store, {
          json: true,
          ...(queued ? { queued: true } : {}),
        })
        expect(JSON.parse(jsonOut.join('\n'))).toEqual(JSON.parse(JSON.stringify(expected)))
      }
    }
  })

  test('the --all scope reads every history and never fetches digests', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'run-1', status: 'running' })
    await seedBuild(store, { slug: 'is-queued', status: 'queued' })
    await seedFinished(store, 'done-1', 'done')
    await seedFinished(store, 'aborted-1', 'aborted')
    const counting = countingStore(store)
    const text = await runCounting(counting.store, { all: true })
    expect(counting.counts.get('getRepoBuildDigests')).toBeUndefined()
    expect(counting.counts.get('getReducerValue')).toBe(4)
    const expected = await legacySummaries(store, { all: true })
    expect(text).toEqual(renderSummaries(expected, NOW, `no builds for ${REPO}`))
    const jsonOut = await runCounting(store, { all: true, json: true })
    expect(JSON.parse(jsonOut.join('\n'))).toEqual(JSON.parse(JSON.stringify(expected)))
  })

  test('adding finished builds leaves the default and --queued rendering unchanged', async () => {
    const base = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(base, { slug: 'run-1', status: 'running' })
    await seedBuild(base, { slug: 'is-queued', status: 'queued' })
    const withFinished = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(withFinished, { slug: 'run-1', status: 'running' })
    await seedBuild(withFinished, { slug: 'is-queued', status: 'queued' })
    await seedFinished(withFinished, 'done-1', 'done')
    await seedFinished(withFinished, 'aborted-1', 'aborted')
    await seedFinished(withFinished, 'done-2', 'done')
    for (const queued of [false, true] as const) {
      const opts = queued ? { queued: true } : {}
      expect(await runCounting(withFinished, opts)).toEqual(await runCounting(base, opts))
    }
  })

  test('a legacy repoOrigin-keyed record still lists via its per-build history read', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'modern', status: 'running' })
    // Legacy record: keyed by an old checkout path and matched only through
    // its normalized origin — no digest entry is expected under `identity`,
    // so it keeps its per-build history read.
    await store.createBuild({ slug: 'legacy', repo: '/old/checkouts/acme-app', repoOrigin: REPO })
    await store.append('legacy', {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
    })
    const counting = countingStore(store)
    const text = (await runCounting(counting.store)).join('\n')
    expect(text).toContain('modern')
    expect(text).toContain('legacy')
    expect(counting.eventSlugs).toContain('legacy')
    // The legacy fallback does not disturb the digest-gated count for the
    // origin-keyed records: one digest read, one history per remaining record.
    expect(counting.counts.get('getRepoBuildDigests')).toBe(1)
    expect(counting.counts.get('getReducerValue')).toBe(2)
  })

  test('a missing digest entry for an identity-keyed record fails loudly', async () => {
    class IncompleteDigestStore extends MemoryBuildStore {
      override async getRepoBuildDigests(repo: string): Promise<Map<string, BuildDigest>> {
        const digests = await super.getRepoBuildDigests(repo)
        digests.delete('modern')
        return digests
      }
    }
    const store = new IncompleteDigestStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'modern', status: 'running' })
    await expect(runCounting(store)).rejects.toThrow(
      'getRepoBuildDigests is missing an entry for build "modern"',
    )
  })
})

describe('abBuildStatus', () => {
  test('reports one build in detail', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const out: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => out.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'b1',
    })
    expect(out.join('\n')).toContain('build b1')
  })

  test('projects the exact current merge-wait reason in human and JSON output', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-status-wait-'))
    try {
      await writeFile(join(workspace, 'autobuild.toml'), MINIMAL_CONFIG)
      const store = new MemoryBuildStore({ clock: steppingClock() })
      const providerDetail = "error: Entry 'autobuild.toml' not uptodate. Cannot merge."
      await seedAwaitingPr(store, workspace, providerDetail)
      await store.claimLease('merge-wait', 'runner-held', 60 * 60 * 1000)

      const human: string[] = []
      await abBuildStatus({
        targetRepo: '/anywhere',
        env: {},
        exec: fakeExec,
        stdout: (line) => human.push(line),
        openStore: () => store,
        now: () => NOW,
        slug: 'merge-wait',
      })
      expect(human.join('\n')).toContain(`waiting:  on PR — Auto-merge gate`)
      expect(human.join('\n')).toContain(providerDetail)

      const json: string[] = []
      await abBuildStatus({
        targetRepo: '/anywhere',
        env: {},
        exec: fakeExec,
        stdout: (line) => json.push(line),
        openStore: () => store,
        now: () => NOW,
        slug: 'merge-wait',
        json: true,
      })
      const parsed = JSON.parse(json.join('\n'))
      expect(parsed.decision.kind).toBe('awaiting-pr')
      expect(parsed.decision.reason).toContain(providerDetail)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('renders an unqualified current PR wait when no deferral was recorded', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-status-bare-wait-'))
    try {
      await writeFile(join(workspace, 'autobuild.toml'), MINIMAL_CONFIG)
      const store = new MemoryBuildStore({ clock: steppingClock() })
      await seedAwaitingPr(store, workspace)
      const out: string[] = []
      await abBuildStatus({
        targetRepo: '/anywhere',
        env: {},
        exec: fakeExec,
        stdout: (line) => out.push(line),
        openStore: () => store,
        now: () => NOW,
        slug: 'merge-wait',
      })
      expect(out.join('\n')).toContain('waiting:  on PR')
      expect(out.join('\n')).not.toContain('Auto-merge gate could not apply consent')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('projects repository completion between PR ending and build completion, including after workspace release', async () => {
    for (const prState of ['merged', 'closed'] as const) {
      for (const released of [false, true]) {
        const store = new MemoryBuildStore({
          clock: steppingClock('2026-07-15T11:00:00.000Z'),
        })
        await seedAwaitingPr(store, `/workspace/${prState}-${released ? 'released' : 'present'}`)
        await store.append('merge-wait', {
          actor: DISPATCHER,
          type: prState === 'merged' ? 'pr.merged' : 'pr.closed',
          payload: prState === 'merged' ? { sha: 'merge-sha' } : {},
        })
        if (released) {
          await store.append('merge-wait', {
            actor: DISPATCHER,
            type: 'workspace.released',
            payload: {},
          })
        }
        await store.claimLease('merge-wait', 'runner-expired', 1000)

        const human: string[] = []
        await abBuildStatus({
          targetRepo: '/anywhere',
          env: {},
          exec: fakeExec,
          stdout: (line) => human.push(line),
          openStore: () => store,
          now: () => NOW,
          slug: 'merge-wait',
        })
        const text = human.join('\n')
        expect(text).toContain(`pr:       #7 (${prState})`)
        expect(text).toContain(`repository-level completion after the PR was ${prState}`)
        expect(text).toContain('no runner re-attachment is pending')
        expect(text).not.toContain('lease sweep will re-attach')
        expect(text).not.toContain('decision: unavailable')

        const json: string[] = []
        await abBuildStatus({
          targetRepo: '/anywhere',
          env: {},
          exec: fakeExec,
          stdout: (line) => json.push(line),
          openStore: () => store,
          now: () => NOW,
          slug: 'merge-wait',
          json: true,
        })
        const parsed = JSON.parse(json.join('\n'))
        expect(parsed.status).toBe('running')
        expect(parsed.lease.health).toBe('expired')
        expect(parsed.pr.state).toBe(prState)
        expect(parsed.decision).toEqual({ kind: 'repository-completion', prState })
        expect(parsed.outcome).toBeUndefined()
      }
    }
  })

  test('degrades missing, unreadable, and remote-only build configs without claiming current reason or re-attachment', async () => {
    const badWorkspace = await mkdtemp(join(tmpdir(), 'ab-status-bad-config-'))
    try {
      await writeFile(join(badWorkspace, 'autobuild.toml'), '[invalid')
      for (const [workspace, refOnly] of [
        [join(badWorkspace, 'missing'), false],
        [badWorkspace, false],
        ['sandbox:remote-host/build-7', true],
      ] as const) {
        const store = new MemoryBuildStore({
          clock: steppingClock('2026-07-15T11:00:00.000Z'),
        })
        await seedAwaitingPr(
          store,
          workspace,
          'historical provider detail that must not look current',
          refOnly,
        )
        await store.claimLease('merge-wait', 'runner-expired', 1000)
        const out: string[] = []
        await abBuildStatus({
          targetRepo: '/anywhere',
          env: {},
          exec: fakeExec,
          stdout: (line) => out.push(line),
          openStore: () => store,
          now: () => NOW,
          slug: 'merge-wait',
        })
        const text = out.join('\n')
        expect(text).toContain('decision: unavailable')
        expect(text).toContain('runner actionability could not be determined')
        expect(text).not.toContain('waiting:  on PR —')
        expect(text).not.toContain('lease sweep will re-attach')
        expect(text).toContain('observations (1)')
        // The diagnostic names the missing sources, never a filesystem path or
        // a raw OS error: for a remote build the recorded path is a guest
        // location the operator cannot access.
        expect(text).not.toContain('autobuild.toml at')
        expect(text).not.toContain('ENOENT')
        expect(text).not.toContain('sandbox:remote-host')
        expect(text).not.toContain(badWorkspace)
      }
    } finally {
      await rm(badWorkspace, { recursive: true, force: true })
    }
  })

  test('derives the decision from the deposited build config when the recorded workspace is a remote guest path', async () => {
    // The dispatcher freezes an effective-config artifact into the store at
    // every runner launch, so a healthy remote build projects its decision
    // from the deposit even though its recorded workspace path exists only
    // inside the guest. The deferral detail proves the artifact path computes
    // the same projection the local-workspace tests get.
    const providerDetail = 'remote workspace never existed on this machine'
    const store = new MemoryBuildStore({ clock: steppingClock('2026-07-15T11:00:00.000Z') })
    await seedAwaitingPr(store, 'sandbox:remote-host/build-7', providerDetail, true)
    await store.putArtifact('merge-wait', {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(parseConfig(MINIMAL_CONFIG)),
      metadata: { revision: 0 },
    })

    const json: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => json.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'merge-wait',
      json: true,
    })
    const parsed = JSON.parse(json.join('\n'))
    expect(parsed.decision.kind).toBe('awaiting-pr')
    expect(parsed.decision.reason).toContain(providerDetail)

    const human: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => human.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'merge-wait',
    })
    const text = human.join('\n')
    expect(text).toContain('waiting:  on PR — Auto-merge gate')
    expect(text).toContain(providerDetail)
    expect(text).not.toContain('decision: unavailable')
    expect(text).not.toContain('sandbox:remote-host')
  })

  test('reports the decision unavailable naming the artifact when neither source has a config', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock('2026-07-15T11:00:00.000Z') })
    await seedAwaitingPr(store, 'sandbox:remote-host/build-7', undefined, true)
    await store.claimLease('merge-wait', 'runner-expired', 1000)

    const json: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => json.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'merge-wait',
      json: true,
    })
    const parsed = JSON.parse(json.join('\n'))
    expect(parsed.decision.kind).toBe('unavailable')
    expect(parsed.decision.diagnostic).toContain('build-runner-effective-config')
    expect(parsed.decision.diagnostic).not.toContain('sandbox:remote-host')
    expect(parsed.decision.diagnostic).not.toContain('ENOENT')

    const human: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => human.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'merge-wait',
    })
    const text = human.join('\n')
    expect(text).toContain('decision: unavailable')
    expect(text).toContain('build-runner-effective-config')
    expect(text).toContain('runner actionability could not be determined')
    expect(text).not.toContain('sandbox:remote-host')
  })

  test('projects from the deposited build config even after the workspace was released', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock('2026-07-15T11:00:00.000Z') })
    await seedAwaitingPr(store, '/workspace/released-after-deposit')
    await store.append('merge-wait', {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: {},
    })
    await store.putArtifact('merge-wait', {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(parseConfig(MINIMAL_CONFIG)),
      metadata: {
        revision: 0,
        pipelineSource: {
          ref: 'branch-head',
          commit: 'abc1234def5678901234567890123456789012345',
        },
      },
    })

    const json: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => json.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'merge-wait',
      json: true,
    })
    const parsed = JSON.parse(json.join('\n'))
    expect(parsed.decision).toEqual({ kind: 'awaiting-pr' })
    // SPEC §16.1 operator visibility: the pinned pipeline source and the
    // effective-config revision travel in the status projection.
    expect(parsed.pipelineSource).toEqual({
      ref: 'branch-head',
      commit: 'abc1234def5678901234567890123456789012345',
    })
    expect(parsed.effectiveConfigRev).toBe(0)

    const human: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => human.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'merge-wait',
    })
    const text = human.join('\n')
    expect(text).toContain('waiting:  on PR')
    expect(text).not.toContain('decision: unavailable')
    expect(text).toContain('pipeline: autobuild.toml@abc1234 (branch-head)  config rev 0')
  })

  test('an unknown slug is an actionable error', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const promise = abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: () => {},
      openStore: () => store,
      now: () => NOW,
      slug: 'nope',
    })
    await expect(promise).rejects.toThrow(/no build "nope"/)
    await expect(promise).rejects.toThrow(/ab builds --all/)
  })

  test('rejects a slug owned by another canonical repository', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'theirs', repo: OTHER_REPO })
    await expect(
      abBuildStatus({
        targetRepo: '/anywhere',
        env: {},
        exec: fakeExec,
        stdout: () => {},
        openStore: () => store,
        now: () => NOW,
        slug: 'theirs',
      }),
    ).rejects.toThrow(`build "theirs" belongs to repository "${OTHER_REPO}", not "${REPO}"`)
  })

  test('accepts a differently located checkout of the same origin (the sandbox guest)', async () => {
    const guest = await mkdtemp(join(tmpdir(), 'ab-status-guest-'))
    try {
      await writeFile(join(guest, 'autobuild.toml'), MINIMAL_CONFIG)
      const store = new MemoryBuildStore({ clock: steppingClock() })
      await store.createBuild({
        slug: 'guest',
        repo: OTHER_REPO,
        repoOrigin: 'https://github.com/acme/app',
      })
      const out: string[] = []
      await abBuildStatus({
        targetRepo: guest,
        env: {},
        exec: guestExec(guest, 'git@github.com:acme/app.git'),
        stdout: (line) => out.push(line),
        openStore: () => store,
        now: () => NOW,
        slug: 'guest',
      })
      expect(out.join('\n')).toContain('build guest')
    } finally {
      await rm(guest, { recursive: true, force: true })
    }
  })

  test('a different origin, or a legacy record without one, is still foreign on path mismatch', async () => {
    const guest = await mkdtemp(join(tmpdir(), 'ab-status-guest-'))
    try {
      await writeFile(join(guest, 'autobuild.toml'), MINIMAL_CONFIG)
      const store = new MemoryBuildStore({ clock: steppingClock() })
      await store.createBuild({
        slug: 'foreign-origin',
        repo: OTHER_REPO,
        repoOrigin: 'https://github.com/other/app',
      })
      await store.createBuild({ slug: 'legacy', repo: OTHER_REPO })
      for (const slug of ['foreign-origin', 'legacy']) {
        await expect(
          abBuildStatus({
            targetRepo: guest,
            env: {},
            exec: guestExec(guest, 'https://github.com/acme/app'),
            stdout: () => {},
            openStore: () => store,
            now: () => NOW,
            slug,
          }),
        ).rejects.toThrow(
          `build "${slug}" belongs to repository "${OTHER_REPO}", not "https://github.com/acme/app"`,
        )
      }
    } finally {
      await rm(guest, { recursive: true, force: true })
    }
  })

  test('--json parses and matches the projection', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const out: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => out.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'b1',
      json: true,
      events: 1,
    })
    const raw = out.join('\n')
    expect(raw).not.toContain('\x1b')
    const parsed = JSON.parse(raw)
    expect(parsed.slug).toBe('b1')
    expect(parsed.events).toHaveLength(1)
  })
})

describe('ambient read authority', () => {
  const buildEnv = {
    AB_STORE: '/phase/store',
    AB_BUILD: 'mine',
    AB_PHASE: 'implement@1',
    AB_SESSION: 's_phase',
  }

  test('own status succeeds while foreign status and repository listing are denied', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'mine' })
    await seedBuild(store, { slug: 'foreign' })

    const out: string[] = []
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: buildEnv,
      exec: fakeExec,
      stdout: (line) => out.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'mine',
    })
    expect(out.join('\n')).toContain('build mine')

    await expect(
      abBuildStatus({
        targetRepo: '/anywhere',
        env: buildEnv,
        exec: fakeExec,
        stdout: () => {},
        openStore: () => store,
        now: () => NOW,
        slug: 'foreign',
      }),
    ).rejects.toBeInstanceOf(PhaseSessionError)
    await expect(
      abBuilds({
        targetRepo: '/anywhere',
        env: buildEnv,
        exec: fakeExec,
        stdout: () => {},
        openStore: () => store,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ operation: 'listBuilds' })
  })

  test('complete Harvest and malformed ambient identities fail without build access', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'mine' })
    await store.ensureRepo(REPO)
    await expect(
      abBuildStatus({
        targetRepo: '/anywhere',
        env: {
          AB_STORE: '/phase/store',
          AB_REPO: REPO,
          AB_HARVEST: 'h_1',
          AB_PHASE: 'review@1',
          AB_SESSION: 'hs_1',
        },
        exec: fakeExec,
        stdout: () => {},
        openStore: () => store,
        slug: 'mine',
      }),
    ).rejects.toBeInstanceOf(PhaseSessionError)

    let opens = 0
    await expect(
      abBuilds({
        targetRepo: '/anywhere',
        env: { AB_SESSION: 'partial' },
        exec: fakeExec,
        stdout: () => {},
        openStore: () => {
          opens += 1
          return store
        },
      }),
    ).rejects.toThrow(/invalid ambient context/)
    expect(opens).toBe(0)
  })
})

describe('own-session ambient authority over a relocated checkout', () => {
  const GUEST = '/vercel/sandbox/workspace'
  // The guest checkout's normalized origin — the repository identity the
  // belongs-to diagnostic names (the identity change; the path is no longer
  // the identity).
  const GUEST_ORIGIN = 'https://github.com/unrelated/guest-origin'
  // A remote-looking store ref: no local session scoping wraps the handle, so
  // what is under test is the command core's own-session gate itself.
  const guestEnv = (build: string) => ({
    AB_STORE: 'https://store.example',
    AB_BUILD: build,
    AB_PHASE: 'implement@1',
    AB_SESSION: 's_guest',
  })

  test('a legacy record without repoOrigin is readable by its own build session', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.createBuild({ slug: 'legacy', repo: OTHER_REPO })
    await store.append('legacy', {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: {
        pr: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: 'abc1234' },
      },
    })
    const out: string[] = []
    await abBuildStatus({
      targetRepo: GUEST,
      env: guestEnv('legacy'),
      exec: guestExec(GUEST, 'https://github.com/unrelated/guest-origin'),
      stdout: (line) => out.push(line),
      openStore: () => store,
      now: () => NOW,
      slug: 'legacy',
      json: true,
    })
    const parsed = JSON.parse(out.join('\n')) as {
      slug: string
      pr?: { number: number; url: string; state?: string }
    }
    expect(parsed.slug).toBe('legacy')
    expect(parsed.pr).toEqual({
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      state: 'open',
    })
  })

  test('a session cannot read a foreign slug from a foreign-repository record', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.createBuild({ slug: 'theirs', repo: OTHER_REPO })
    await expect(
      abBuildStatus({
        targetRepo: GUEST,
        env: guestEnv('mine'),
        exec: guestExec(GUEST, 'https://github.com/unrelated/guest-origin'),
        stdout: () => {},
        openStore: () => store,
        now: () => NOW,
        slug: 'theirs',
      }),
    ).rejects.toThrow('phase-session store scoped to build')
  })

  test('an explicit --store other than the session store does not authorize the bypass', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.createBuild({ slug: 'legacy', repo: OTHER_REPO })
    await expect(
      abBuildStatus({
        targetRepo: GUEST,
        env: guestEnv('legacy'),
        exec: guestExec(GUEST, 'https://github.com/unrelated/guest-origin'),
        stdout: () => {},
        openStore: () => store,
        now: () => NOW,
        slug: 'legacy',
        storeRef: 'https://other-store.example',
      }),
    ).rejects.toThrow(`build "legacy" belongs to repository "${OTHER_REPO}", not "${GUEST_ORIGIN}"`)
  })

  test('a Harvest identity never authorizes the bypass, even on slug-shaped matches', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.createBuild({ slug: 'legacy', repo: OTHER_REPO })
    await expect(
      abBuildStatus({
        targetRepo: GUEST,
        env: {
          AB_STORE: 'https://store.example',
          AB_REPO: OTHER_REPO,
          AB_HARVEST: 'h_1',
          AB_PHASE: 'review@1',
          AB_SESSION: 's_harvest',
        },
        exec: guestExec(GUEST, 'https://github.com/unrelated/guest-origin'),
        stdout: () => {},
        openStore: () => store,
        now: () => NOW,
        slug: 'legacy',
      }),
    ).rejects.toThrow('phase-session store scoped to repo')
  })
})

describe('store selection', () => {
  test('--store wins over AB_STORE, which wins over the default', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const seen: string[] = []
    const opts = {
      targetRepo: '/anywhere',
      exec: fakeExec,
      stdout: () => {},
      openStore: (ref: string) => {
        seen.push(ref)
        return store
      },
      now: () => NOW,
    }
    await abBuilds({ ...opts, env: {}, storeRef: '/explicit' })
    await abBuilds({ ...opts, env: { AB_STORE: '/from-env' } })
    await abBuilds({ ...opts, env: { AB_STORE: '/from-env' }, storeRef: '/explicit' })
    await abBuilds({ ...opts, env: {} })
    expect(seen[0]).toBe('/explicit')
    expect(seen[1]).toBe('/from-env')
    expect(seen[2]).toBe('/explicit')
    expect(seen[3]).toBe(`${REPO}/.autobuild`)
  })

  test('AB_TOKEN is passed through for remote refs', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    let token: string | undefined
    await abBuilds({
      targetRepo: '/anywhere',
      env: { AB_STORE: 'https://store.example', AB_TOKEN: 'tok_1' },
      exec: fakeExec,
      stdout: () => {},
      openStore: (_ref, tok) => {
        token = tok
        return store
      },
      now: () => NOW,
    })
    expect(token).toBe('tok_1')
  })
})

describe('read-only guarantee', () => {
  /** Every mutating method throws — the AC is its own test, not an inspection. */
  function readOnlyProxy(store: MemoryBuildStore): BuildStore {
    const forbidden = [
      'append',
      'appendWithArtifacts',
      'putArtifact',
      'claimLease',
      'heartbeat',
      'releaseLease',
      'createBuild',
    ]
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && forbidden.includes(prop)) {
          return () => {
            throw new Error(`read-only violation: store.${prop} was called`)
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as unknown as BuildStore
  }

  test('neither command mutates the store', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const before = (await store.getEvents('b1')).length
    const guarded = readOnlyProxy(store)

    await abBuilds({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: () => {},
      openStore: () => guarded,
      now: () => NOW,
      all: true,
    })
    await abBuildStatus({
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: () => {},
      openStore: () => guarded,
      now: () => NOW,
      slug: 'b1',
      events: 5,
    })

    expect((await store.getEvents('b1')).length).toBe(before)
    const after = await store.getBuild('b1')
    expect(after?.lease).toBeUndefined()
  })
})

describeStoreOpeningContract('ab builds', {
  run: (opts) =>
    abBuilds({
      ...opts,
      all: true,
      json: true,
      now: () => NOW,
    }),
  canonicalMarker: (stdout) =>
    (JSON.parse(stdout.join('\n')) as Array<{ slug: string }>)
      .map((summary) => summary.slug)
      .sort()
      .join(','),
  expectedCanonicalMarker: 'main-build',
})

describe('store lifecycle', () => {
  test('the store is closed even when the build is unknown', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    let closed = false
    const tracked = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'close') {
          return async () => {
            closed = true
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    }) as unknown as BuildStore

    await expect(
      abBuildStatus({
        targetRepo: '/anywhere',
        env: {},
        exec: fakeExec,
        stdout: () => {},
        openStore: () => tracked,
        now: () => NOW,
        slug: 'missing',
      }),
    ).rejects.toThrow()
    expect(closed).toBe(true)
  })
})

describe('detail: session stream status (SPEC §9)', () => {
  test('open sessions gain stream id and open/closed from the store records', async () => {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug: 'b1' })
    const started = await store.append('b1', {
      actor: KERNEL,
      type: 'session.started',
      payload: { session: 's_1', role: 'plan', runner: 'claude', phase: 'plan', round: 1 },
    })
    await store.createStream({ kind: 'build', build: 'b1' }, 'session:s_1')

    const withoutStreams = detail((await store.getBuild('b1'))!, await store.getEvents('b1'), NOW)
    expect(withoutStreams.openSessions[0]).toMatchObject({ session: 's_1' })
    expect(withoutStreams.openSessions[0]?.stream).toBeUndefined()

    const streams = await store.listStreams({ kind: 'build', build: 'b1' })
    const enriched = detail(
      (await store.getBuild('b1'))!,
      await store.getEvents('b1'),
      NOW,
      undefined,
      undefined,
      streams,
    )
    expect(enriched.openSessions[0]).toMatchObject({
      session: 's_1',
      seq: started.seq,
      stream: streams[0]!.id,
      streamStatus: 'open',
    })

    // Human output names the stream and its status.
    const lines = renderDetail(enriched, NOW).join('\n')
    expect(lines).toContain(`stream ${streams[0]!.id} (open)`)
    await store.close()
  })

  test('abBuildStatus human and --json output carry the stream fields', async () => {
    const lines: string[] = []
    const slug = 'b1'
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await seedBuild(store, { slug })
    await store.append(slug, {
      actor: KERNEL,
      type: 'session.started',
      payload: { session: 's_1', role: 'plan', runner: 'claude', phase: 'plan', round: 1 },
    })
    const stream = await store.createStream({ kind: 'build', build: slug }, 'session:s_1')

    await abBuildStatus({
      slug,
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => lines.push(line),
      openStore: () => store,
      now: () => NOW,
    })
    expect(lines.join('\n')).toContain(`stream ${stream.id} (open)`)

    const json: string[] = []
    await abBuildStatus({
      slug,
      targetRepo: '/anywhere',
      env: {},
      exec: fakeExec,
      stdout: (line) => json.push(line),
      json: true,
      openStore: () => store,
      now: () => NOW,
    })
    const detailJson = JSON.parse(json.join('\n')) as {
      openSessions: Array<{ stream?: string; streamStatus?: string }>
    }
    expect(detailJson.openSessions[0]).toMatchObject({
      stream: stream.id,
      streamStatus: 'open',
    })
    await store.close()
  })
})

describe('abBuildAssetGet', () => {
  const enc = (text: string) => new TextEncoder().encode(text)
  const asset = (text: string) => ({
    kind: 'mock',
    name: 'a.txt',
    layout: 'file' as const,
    entries: [{ type: 'file' as const, path: 'a.txt', content: enc(text) }],
  })

  async function finishedBuild(): Promise<MemoryBuildStore> {
    const store = new MemoryBuildStore({ clock: steppingClock() })
    await store.putTicketAsset(REPO, 'ENG-1', asset('pinned'))
    await store.createBuild({
      slug: 'b1',
      repo: REPO,
      ticket: { source: 'linear', id: 'ENG-1', title: 'A ticket' },
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: {
          ticket: { source: 'linear', id: 'ENG-1' },
          repo: REPO,
          baseBranch: 'main',
          assets: [
            {
              kind: 'mock',
              name: 'a.txt',
              revision: 0,
              layout: 'file',
              size: 6,
              fileCount: 1,
              dirCount: 0,
            },
          ],
        },
      },
    })
    await store.append('b1', {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
    return store
  }

  test('downloads the pinned bytes by build and name after the build finished and the ticket moved on', async () => {
    const store = await finishedBuild()
    await store.putTicketAsset(REPO, 'ENG-1', asset('replaced'))
    await store.removeTicketAsset(REPO, 'ENG-1', 'mock', 'a.txt')
    const dir = await mkdtemp(join(tmpdir(), 'ab-build-asset-'))
    try {
      const out: string[] = []
      await abBuildAssetGet({
        targetRepo: '/anywhere',
        env: {},
        exec: fakeExec,
        stdout: (line) => out.push(line),
        openStore: () => store,
        slug: 'b1',
        kind: 'mock',
        name: 'a.txt',
        dest: join(dir, 'out.txt'),
      })
      expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('pinned')
      expect(out.join('\n')).toContain('b1 mock/a.txt revision 0')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('names a build that never pinned the asset, and an unknown build', async () => {
    const store = await finishedBuild()
    const run = (slug: string, name: string) =>
      abBuildAssetGet({
        targetRepo: '/anywhere',
        env: {},
        exec: fakeExec,
        stdout: () => {},
        openStore: () => store,
        slug,
        kind: 'mock',
        name,
        dest: '/tmp/never-written',
      })
    await expect(run('b1', 'nope')).rejects.toThrow('pinned no ticket asset mock/nope')
    await expect(run('missing', 'a.txt')).rejects.toThrow('no build "missing"')
  })
})

test('node status exposes idle evidence and wakes immediately on durable activity', async () => {
  const { nodeActivityKey } = await import('../kernel/node-polling')
  const { readBuildFacts } = await import('../store/reduced-reads')
  let time = new Date('2026-07-15T11:50:00Z')
  const store = new MemoryBuildStore({ clock: () => time })
  const slug = 'idle-node'
  await store.createBuild({
    slug,
    repo: REPO,
    created: {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo: REPO,
        kind: 'node',
        baseBranch: 'main',
        ticket: { source: 'fake', id: 'N' },
      },
    },
  })
  await store.append(slug, { actor: DISPATCHER, type: 'node.opened', payload: { sha: 'head' } })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'node.compared',
    payload: { headSha: 'head', parentSha: 'parent', ahead: 0 },
  })
  const key = nodeActivityKey((await readBuildFacts(store, slug)).value.state, [])
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'node.poll-checked',
    payload: {
      activityKey: key,
      unchangedSince: time.toISOString(),
      nodeIdleAfterSeconds: 600,
      nodeIdlePollSeconds: 120,
    },
  })
  const output = async (json: boolean) => {
    const lines: string[] = []
    await abBuildStatus({
      slug,
      targetRepo: REPO,
      env: {},
      exec: fakeExec,
      stdout: (line) => lines.push(line),
      json,
      openStore: () => store,
      now: () => NOW,
    })
    return lines.join('\n')
  }
  expect(JSON.parse(await output(true)).nodePolling).toMatchObject({
    mode: 'idle',
    intervalSeconds: 120,
    lastChecked: time.toISOString(),
  })
  expect(await output(false)).toContain(
    `idle; polled every 120 seconds; last checked: ${time.toISOString()}`,
  )
  // A held node's launch artifact still has 120, but hot policy has moved to
  // 300 and the successful checkpoint is the evidence status must display.
  await store.putArtifact(slug, {
    kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
    content: effectiveBuildConfigContent(parseConfig(MINIMAL_CONFIG)),
  })
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'node.poll-checked',
    payload: {
      activityKey: key,
      unchangedSince: time.toISOString(),
      nodeIdleAfterSeconds: 600,
      nodeIdlePollSeconds: 300,
    },
  })
  expect(JSON.parse(await output(true)).nodePolling).toMatchObject({
    mode: 'idle',
    intervalSeconds: 300,
  })
  expect(await output(false)).toContain('idle; polled every 300 seconds')
  time = NOW
  await store.append(slug, {
    actor: humanActor('operator'),
    type: 'build.hold-requested',
    payload: {},
  })
  expect(JSON.parse(await output(true)).nodePolling.mode).toBe('active')
  await store.append(slug, {
    actor: DISPATCHER,
    type: 'build.completed',
    payload: { outcome: 'closed-unmerged' },
  })
  expect(JSON.parse(await output(true)).nodePolling).toBeUndefined()
})
