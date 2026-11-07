import { describe, expect, test } from 'bun:test'
import type { Forge, PrState } from '../types'
import { describeForgeContract, type ForgeContractFactory } from './contract'
import { FakeForge } from './fake'

const prOpts = (over: Partial<Parameters<Forge['openPr']>[0]> = {}) => ({
  workspacePath: '/ws/a',
  head: 'ab/fix-login',
  base: 'main',
  title: 'Fix login',
  body: 'Body text',
  ...over,
})

const fakeForgeContractFactory: ForgeContractFactory = async (opts = {}) => {
  const headSha = `head-${crypto.randomUUID()}`
  const landingSha = `squash-${crypto.randomUUID()}`
  const head = `ab/contract-head-${crypto.randomUUID()}`
  const forge = new FakeForge({
    headSha,
    mergeSha: landingSha,
    gatePresence: opts.gated ? 'present' : 'absent',
  })
  forge.seedBranch(head, headSha)
  const base = `contract-base-${crypto.randomUUID()}`
  forge.seedBranch(base, `base-${crypto.randomUUID()}`)
  return {
    forge,
    workspacePath: `/fake/forge-contract/${crypto.randomUUID()}`,
    head,
    base,
    title: `Forge contract ${crypto.randomUUID()}`,
    body: 'Autobuild Forge contract fixture',
    controls: {
      remoteHead: async (branch) => {
        if (!forge.hasPublishedBranch(branch)) {
          throw new Error(`fake contract probe: branch ${branch} was not pushed`)
        }
        return headSha
      },
      prepareMergeable: async (number) => {
        forge.setPrState(number, { state: 'open', mergeable: true })
      },
      closePr: async (number) => {
        forge.setPrState(number, { state: 'closed' })
      },
      makeConflict: async (number) => {
        forge.setPrState(number, { state: 'open', mergeable: false })
      },
      advanceHead: async (number) => {
        const sha = `advanced-${crypto.randomUUID()}`
        forge.setPrHeadSha(number, sha)
        forge.setPrState(number, { state: 'open', mergeable: true })
        return sha
      },
      nativeAutoMergeEnabled: async (number) => forge.isAutoMergeEnabled(number),
      commentExists: async (number, body) =>
        forge.comments.some((comment) => comment.number === number && comment.body === body),
      mergeSha: async () => landingSha,
      trackPr: () => {},
      editPr: (number, edit) => forge.editPr(number, edit),
      armMergeCommitAutoMerge: (number) =>
        forge.armAutoMerge(number, { method: 'MERGE', headline: 'Merge pull request', body: '' }),
    },
  }
}

describeForgeContract('FakeForge', fakeForgeContractFactory)

describe('FakeForge', () => {
  test('pushBranch journals workspacePath and branch in call order', async () => {
    const forge = new FakeForge()
    await forge.pushBranch('/ws/a', 'ab/fix-login')
    await forge.pushBranch('/ws/b', 'ab/other')
    expect(forge.pushes).toEqual([
      { workspacePath: '/ws/a', branch: 'ab/fix-login' },
      { workspacePath: '/ws/b', branch: 'ab/other' },
    ])
  })

  test('openPr assigns numbers 1,2,… with fake url and default sha-<n>', async () => {
    const forge = new FakeForge()
    const first = await forge.openPr(prOpts())
    const second = await forge.openPr(prOpts({ head: 'ab/other' }))
    expect(first).toEqual({
      number: 1,
      url: 'https://fake.forge/pr/1',
      headSha: 'sha-1',
    })
    expect(second).toEqual({
      number: 2,
      url: 'https://fake.forge/pr/2',
      headSha: 'sha-2',
    })
  })

  test('openPr journals the full opts', async () => {
    const forge = new FakeForge()
    await forge.openPr(prOpts())
    expect(forge.opened).toEqual([prOpts()])
  })

  test('openPr adopts an existing open PR for the same head — idempotent, mirroring GitHubForge (§8.7)', async () => {
    const forge = new FakeForge()
    const first = await forge.openPr(prOpts())
    const retry = await forge.openPr(prOpts({ title: 'retry after crash' }))
    expect(retry).toEqual(first)
    // Only true creations are journaled — the index keeps mapping to the number.
    expect(forge.opened).toHaveLength(1)

    // A PR that is no longer open is not adopted: a fresh one is created.
    forge.setPrState(first.number, { state: 'closed' })
    const reopened = await forge.openPr(prOpts())
    expect(reopened.number).toBe(2)
    expect(forge.opened).toHaveLength(2)
  })

  test('headSha is settable via constructor', async () => {
    const forge = new FakeForge({ headSha: 'abc123' })
    expect((await forge.openPr(prOpts())).headSha).toBe('abc123')
  })

  test('headSha is settable via setHeadSha, constant or per-number', async () => {
    const forge = new FakeForge()
    forge.setHeadSha('deadbeef')
    expect((await forge.openPr(prOpts())).headSha).toBe('deadbeef')
    forge.setHeadSha((n) => `custom-${n}`)
    // A distinct head — the same head would be adopted, not re-created (§8.7).
    expect((await forge.openPr(prOpts({ head: 'ab/other' }))).headSha).toBe('custom-2')
  })

  test('getPrState journals workspacePath and number', async () => {
    const forge = new FakeForge()
    const { number } = await forge.openPr(prOpts())
    expect(await forge.getPrState('/ws/a', number)).toMatchObject({
      state: 'open',
      mergeable: null,
    })
    await forge.getPrState('/ws/b', number)
    expect(forge.getPrStateCalls).toEqual([
      { workspacePath: '/ws/a', number },
      { workspacePath: '/ws/b', number },
    ])
  })

  test('setPrState drives a janitor scenario: conflicted then merged', async () => {
    // SPEC §15.7: mergeable false → pr.conflicted; merged carries the
    // squash-commit sha.
    const forge = new FakeForge()
    const { number } = await forge.openPr(prOpts())

    forge.setPrState(number, { state: 'open', mergeable: false })
    expect(await forge.getPrState('/ws/a', number)).toMatchObject({
      state: 'open',
      mergeable: false,
    })

    forge.setPrState(number, { state: 'merged', sha: 'squash-sha' })
    expect(await forge.getPrState('/ws/a', number)).toEqual({
      state: 'merged',
      sha: 'squash-sha',
    })
  })

  test('setPrState seeds PRs the fake never opened', async () => {
    const forge = new FakeForge()
    const state: PrState = { state: 'closed' }
    forge.setPrState(99, state)
    expect(await forge.getPrState('/ws/a', 99)).toMatchObject(state)
    await forge.commentOnPr('/ws/a', 99, 'seeded')
    expect(forge.comments).toEqual([{ workspacePath: '/ws/a', number: 99, body: 'seeded' }])
  })

  test('setAutoMerge tracks native state and journals idempotent retries', async () => {
    const forge = new FakeForge()
    const { number } = await forge.openPr(prOpts())
    expect(forge.isAutoMergeEnabled(number)).toBe(false)

    await forge.setAutoMerge('/ws/a', number, true)
    await forge.setAutoMerge('/ws/a', number, true)
    await forge.setAutoMerge('/ws/a', number, false)

    expect(forge.isAutoMergeEnabled(number)).toBe(false)
    expect(forge.autoMergeCalls).toEqual([
      { workspacePath: '/ws/a', number, enabled: true, changed: true },
      { workspacePath: '/ws/a', number, enabled: true, changed: false },
      { workspacePath: '/ws/a', number, enabled: false, changed: true },
    ])
  })

  test('seeded PRs carry independently seedable auto-merge state', async () => {
    const forge = new FakeForge()
    forge.setPrState(99, { state: 'open', mergeable: true })
    forge.setAutoMergeState(99, true)
    expect(forge.isAutoMergeEnabled(99)).toBe(true)
    await forge.setAutoMerge('/repo', 99, false)
    expect(forge.isAutoMergeEnabled(99)).toBe(false)
  })

  test('setAutoMerge rejects an unknown PR without journaling', async () => {
    const forge = new FakeForge()
    await expect(forge.setAutoMerge('/ws/a', 7, true)).rejects.toThrow('unknown PR #7')
    expect(forge.autoMergeCalls).toEqual([])
  })

  test('gate presence is independent: gated CLEAN applies native, ungated CLEAN is a candidate', async () => {
    const gated = new FakeForge({ gatePresence: 'present' })
    const gatedPr = await gated.openPr(prOpts())
    gated.setPrState(gatedPr.number, { state: 'open', mergeable: true })
    expect(await gated.setAutoMerge('/ws/a', gatedPr.number, true)).toEqual({
      kind: 'applied',
    })
    expect(gated.isAutoMergeEnabled(gatedPr.number)).toBe(true)

    const ungated = new FakeForge({
      gatePresence: 'absent',
      headSha: 'expected-head',
    })
    const ungatedPr = await ungated.openPr(prOpts())
    ungated.setPrState(ungatedPr.number, { state: 'open', mergeable: true })
    expect(await ungated.setAutoMerge('/ws/a', ungatedPr.number, true)).toEqual({
      kind: 'ungated',
      headSha: 'expected-head',
    })
    expect(ungated.isAutoMergeEnabled(ungatedPr.number)).toBe(false)
  })

  test('ungated UNKNOWN defers; UNSTABLE remains direct-merge eligible', async () => {
    const forge = new FakeForge({ gatePresence: 'absent' })
    const pr = await forge.openPr(prOpts())
    expect(await forge.setAutoMerge('/ws/a', pr.number, true)).toEqual({
      kind: 'deferred',
    })
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    forge.setMergeStateStatus(pr.number, 'UNSTABLE')
    expect(await forge.setAutoMerge('/ws/a', pr.number, true)).toEqual({
      kind: 'ungated',
      headSha: pr.headSha,
    })
  })

  test('guarded squash journals separately and becomes observable as merged', async () => {
    const forge = new FakeForge({
      gatePresence: 'absent',
      headSha: 'head-1',
      mergeSha: 'squash-1',
    })
    const pr = await forge.openPr(prOpts())
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    const candidate = await forge.setAutoMerge('/ws/a', pr.number, true)
    expect(candidate).toEqual({ kind: 'ungated', headSha: 'head-1' })

    await forge.squashMerge('/ws/a', pr.number, 'head-1')
    expect(forge.squashMergeCalls).toEqual([
      { workspacePath: '/ws/a', number: pr.number, expectedHeadSha: 'head-1' },
    ])
    expect(await forge.getPrState('/ws/a', pr.number)).toEqual({
      state: 'merged',
      sha: 'squash-1',
    })
  })

  test('issue keywords are composed only when the fake declares closesIssues', async () => {
    const issueLinks = [
      { issue: 820, intent: 'closes' as const },
      { issue: 824, intent: 'refs' as const },
    ]
    const plain = new FakeForge()
    expect(plain.closesIssues).toBeUndefined()
    await plain.openPr(prOpts({ title: 'Fixes #824', body: 'fixes #824\n', issueLinks }))
    expect(plain.opened[0]).toMatchObject({ title: 'Fixes #824', body: 'fixes #824\n' })

    const forge = new FakeForge({
      gatePresence: 'absent',
      mergeSha: 'squash-1',
      closesIssues: true,
    })
    const pr = await forge.openPr(
      prOpts({
        title: 'Fixes #824',
        body: 'This fixes #824\n',
        mergeMessage: '# Fixes #824\n\nThis fixes #824\n',
        issueLinks,
      }),
    )
    expect(forge.opened[0]).toMatchObject({
      title: 'Refs #824',
      body: 'This refs #824\n\nCloses #820\nRefs #824\n',
    })
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    await forge.squashMerge('/ws/a', pr.number, 'sha-1', { buildSlug: 'linked-build', issueLinks })
    expect(await forge.readCommitMessage('/ws/a', 'squash-1')).toBe(
      '# Refs #824\n\nThis refs #824\n\nCloses #820\nRefs #824\n\nAutobuild-Build: linked-build\n',
    )
  })

  test('PR issue-link updates exist only with closesIssues and rewrite the body', async () => {
    expect(new FakeForge().updatePrIssueLinks).toBeUndefined()
    const forge = new FakeForge({ closesIssues: true })
    const pr = await forge.openPr(prOpts({ body: 'Integration.\n\nCloses #5\n' }))
    const links = [
      { issue: 5, intent: 'refs' as const },
      { issue: 7, intent: 'closes' as const },
    ]
    await forge.updatePrIssueLinks!('/ws/a', pr.number, links)
    expect(forge.opened[0]!.body).toBe('Integration.\n\nRefs #5\nCloses #7\n')
    expect(forge.issueLinkUpdates).toEqual([{ number: pr.number, issueLinks: links }])
    forge.failIssueLinkReadback = true
    await expect(forge.updatePrIssueLinks!('/ws/a', pr.number, links)).rejects.toThrow(
      'readback disagrees',
    )
    forge.setPrState(pr.number, { state: 'closed' })
    forge.failIssueLinkReadback = false
    await expect(forge.updatePrIssueLinks!('/ws/a', pr.number, links)).rejects.toThrow('not open')
  })

  test('guarded squash rejects a moved head and never journals or lands it', async () => {
    const forge = new FakeForge({ gatePresence: 'absent', headSha: 'old-head' })
    const pr = await forge.openPr(prOpts())
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    const candidate = await forge.setAutoMerge('/ws/a', pr.number, true)
    expect(candidate).toEqual({ kind: 'ungated', headSha: 'old-head' })
    forge.setPrHeadSha(pr.number, 'new-head')

    await expect(forge.squashMerge('/ws/a', pr.number, 'old-head')).rejects.toThrow('head changed')
    expect(forge.squashMergeCalls).toEqual([])
    expect(await forge.getPrState('/ws/a', pr.number)).toMatchObject({
      state: 'open',
      mergeable: true,
    })
  })

  test('gate-probe errors and unexplained blockers return observable deferrals instead of self-merging', async () => {
    const forge = new FakeForge({ gatePresence: 'absent' })
    const pr = await forge.openPr(prOpts())
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    forge.setGateProbeError(pr.number, 'rulesets forbidden')
    expect(await forge.setAutoMerge('/ws/a', pr.number, true)).toEqual({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: 'rulesets forbidden' },
    })

    forge.setGatePresence(pr.number, 'absent')
    forge.setMergeStateStatus(pr.number, 'BLOCKED')
    expect(await forge.setAutoMerge('/ws/a', pr.number, true)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'unproven-gate-state', detail: expect.stringContaining('BLOCKED') },
    })
    expect(forge.squashMergeCalls).toEqual([])
  })

  test('a seeded mergeability-uncomputed deferral flows through verbatim', async () => {
    // The transient-flavored reason the GitHub forge returns for a persistent
    // mergeable_state 'unknown'; dispatcher-level tests seed it on the fake.
    const forge = new FakeForge()
    const pr = await forge.openPr(prOpts())
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    forge.setAutoMergeDeferral(pr.number, {
      code: 'mergeability-uncomputed',
      detail:
        "GitHub reported mergeable_state 'UNKNOWN' for PR #7 — mergeability was still being " +
        'computed (transient) after 2 re-queries over 2000 ms; native auto-merge was not enabled',
    })
    expect(await forge.setAutoMerge('/ws/a', pr.number, true)).toEqual({
      kind: 'deferred',
      reason: {
        code: 'mergeability-uncomputed',
        detail:
          "GitHub reported mergeable_state 'UNKNOWN' for PR #7 — mergeability was still being " +
          'computed (transient) after 2 re-queries over 2000 ms; native auto-merge was not enabled',
      },
    })
    expect(forge.isAutoMergeEnabled(pr.number)).toBe(false)
  })

  test('a seeded merge-conflicts deferral flows through verbatim', async () => {
    // The conflict-naming reason the GitHub forge returns for a persistent
    // mergeable_state 'DIRTY'; dispatcher-level tests seed it on the fake.
    const forge = new FakeForge()
    const pr = await forge.openPr(prOpts())
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    forge.setAutoMergeDeferral(pr.number, {
      code: 'merge-conflicts',
      detail:
        "GitHub reports mergeable_state 'DIRTY' for PR #7 — the head branch has merge conflicts " +
        "with 'main'; update the branch or resolve the conflicts and the pending consent will be " +
        're-examined on a later tick. Native auto-merge was not enabled',
    })
    expect(await forge.setAutoMerge('/ws/a', pr.number, true)).toEqual({
      kind: 'deferred',
      reason: {
        code: 'merge-conflicts',
        detail:
          "GitHub reports mergeable_state 'DIRTY' for PR #7 — the head branch has merge conflicts " +
          "with 'main'; update the branch or resolve the conflicts and the pending consent will be " +
          're-examined on a later tick. Native auto-merge was not enabled',
      },
    })
    expect(forge.isAutoMergeEnabled(pr.number)).toBe(false)
  })

  test('all non-transient reason families are configurable and leave native state off', async () => {
    const forge = new FakeForge()
    const pr = await forge.openPr(prOpts())
    forge.setPrState(pr.number, { state: 'open', mergeable: true })

    forge.setRulesetsPlanLimitation(pr.number)
    expect(await forge.setAutoMerge('/ws/a', pr.number, true)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'github-plan-limitation' },
    })
    forge.setRepositoryAutoMergeDisabled(pr.number)
    expect(await forge.setAutoMerge('/ws/a', pr.number, true)).toMatchObject({
      kind: 'deferred',
      reason: { code: 'repository-auto-merge-disabled' },
    })
    expect(forge.isAutoMergeEnabled(pr.number)).toBe(false)
  })

  test('commentOnPr journals comments in order', async () => {
    const forge = new FakeForge()
    const { number } = await forge.openPr(prOpts())
    await forge.commentOnPr('/ws/a', number, 'first')
    await forge.commentOnPr('/ws/a', number, 'second')
    expect(forge.comments).toEqual([
      { workspacePath: '/ws/a', number: 1, body: 'first' },
      { workspacePath: '/ws/a', number: 1, body: 'second' },
    ])
  })

  test('getPrState throws on an unknown PR number', async () => {
    const forge = new FakeForge()
    await expect(forge.getPrState('/ws/a', 7)).rejects.toThrow('unknown PR #7')
  })

  test('commentOnPr throws on an unknown PR number and journals nothing', async () => {
    const forge = new FakeForge()
    await expect(forge.commentOnPr('/ws/a', 7, 'hi')).rejects.toThrow('unknown PR #7')
    expect(forge.comments).toEqual([])
  })

  test('PR attachment hosting is unsupported by default and opt-in hosting is adoptable', async () => {
    expect(new FakeForge().prAttachments).toBeUndefined()
    const forge = new FakeForge({ prAttachments: true })
    const request = {
      workspacePath: '/ws/a',
      target: {
        provider: 'github-release' as const,
        repository: 'acme/review-assets',
        releaseId: 42,
      },
      prUrl: 'https://fake.forge/pr/1',
      attachment: {
        artifact: { kind: 'visual:screenshot', rev: 0 },
        filename: 'screenshot.png',
        mediaType: 'image/png',
      },
      content: new Uint8Array([1, 2, 3]),
      sha256: 'a'.repeat(64),
    }
    const first = await forge.prAttachments!.upload(request)
    const second = await forge.prAttachments!.upload(request)
    expect(second).toEqual(first)
    expect(forge.prAttachmentUploads).toHaveLength(2)

    await forge.prAttachments!.reclaim({
      workspacePath: '/repos/main',
      asset: first,
    })
    await forge.prAttachments!.reclaim({
      workspacePath: '/repos/main',
      asset: first,
    })
    expect(forge.prAttachmentReclaims).toHaveLength(2)
  })

  test('attachment upload and reclaim failures are injectable one call at a time', async () => {
    const forge = new FakeForge({ prAttachments: true })
    const request = {
      workspacePath: '/ws/a',
      target: {
        provider: 'github-release' as const,
        repository: 'acme/review-assets',
        releaseId: 42,
      },
      prUrl: 'https://fake.forge/pr/1',
      attachment: {
        artifact: { kind: 'visual:screenshot', rev: 0 },
        filename: 'screenshot.png',
        mediaType: 'image/png',
      },
      content: new Uint8Array([1]),
      sha256: 'b'.repeat(64),
    }
    forge.failNextPrAttachmentUpload('upload unavailable')
    await expect(forge.prAttachments!.upload(request)).rejects.toThrow('upload unavailable')
    const asset = await forge.prAttachments!.upload(request)
    forge.failNextPrAttachmentReclaim('delete unavailable')
    await expect(
      forge.prAttachments!.reclaim({ workspacePath: '/repos/main', asset }),
    ).rejects.toThrow('delete unavailable')
    await expect(
      forge.prAttachments!.reclaim({ workspacePath: '/repos/main', asset }),
    ).resolves.toBeUndefined()
  })
})

test('fake models immutable build identity and actual landing messages independently of the PR description', async () => {
  const forge = new FakeForge({ gatePresence: 'absent' })
  const pr = await forge.openPr(prOpts({ mergeMessage: 'Original\n\nCo-authored-by: A\n' }))
  forge.setPrState(pr.number, { state: 'open', mergeable: true })
  await forge.squashMerge('/ws/a', pr.number, pr.headSha, { buildSlug: 'immutable-slug' })
  const state = await forge.getPrState('/ws/a', pr.number)
  if (state.state !== 'merged') throw new Error('expected merge')
  expect(await forge.readCommitMessage('/ws/a', state.sha)).toBe(
    'Original\n\nCo-authored-by: A\nAutobuild-Build: immutable-slug\n',
  )
  expect(forge.opened[0]?.mergeMessage).toBe('Original\n\nCo-authored-by: A\n')
  forge.remoteBranches.set('base', state.sha)
  expect(await forge.containsBuild('/ws/a', 'base', 'immutable-slug')).toBe(true)
  expect(await forge.containsBuild('/ws/a', 'base', 'immutable')).toBe(false)
  await expect(forge.containsBuild('/ws/a', 'missing', 'immutable-slug')).rejects.toThrow()
})

describe('FakeForge armed native identity', () => {
  const slug = 'build-x'
  const options = { buildSlug: slug, baseBranch: 'main' }
  const trailer = `Autobuild-Build: ${slug}`
  const trailers = (body: string) =>
    body.split('\n').filter((line) => line.startsWith('Autobuild-Build:'))
  const seeded = () => {
    const forge = new FakeForge()
    forge.setPrState(1, { state: 'open', mergeable: true })
    return forge
  }
  const lastCall = (forge: FakeForge) => forge.autoMergeCalls.at(-1)!

  test('a setPrState-only PR arms with seeded defaults and the trailer', async () => {
    const forge = seeded()
    expect(await forge.setAutoMerge('/ws', 1, true, options)).toEqual({ kind: 'applied' })
    const armed = forge.armedAutoMerge(1)!
    expect(armed.method).toBe('SQUASH')
    expect(armed.headline).toBe('Fake PR #1 (#1)')
    expect(trailers(armed.body)).toEqual([trailer])
    expect(lastCall(forge).armed).toEqual(armed)
    expect(forge.identityReads).toEqual([])
  })

  test('a current message is only read', async () => {
    const forge = seeded()
    await forge.setAutoMerge('/ws', 1, true, options)
    const armed = forge.armedAutoMerge(1)
    expect(await forge.setAutoMerge('/ws', 1, true, options)).toEqual({ kind: 'applied' })
    expect(lastCall(forge).changed).toBe(false)
    expect(forge.armedAutoMerge(1)).toEqual(armed)
    expect(forge.identityReads).toEqual([1])
  })

  test('a title edit replaces the headline and keeps the body', async () => {
    const forge = seeded()
    await forge.setAutoMerge('/ws', 1, true, options)
    const before = forge.armedAutoMerge(1)!
    forge.editPr(1, { title: 'Edited' })
    expect(forge.armedAutoMerge(1)).toEqual(before)
    expect(await forge.setAutoMerge('/ws', 1, true, options)).toEqual({ kind: 'applied' })
    expect(lastCall(forge).changed).toBe(true)
    expect(forge.armedAutoMerge(1)).toEqual({ ...before, headline: 'Edited (#1)' })
  })

  test('a body edit replaces the body and keeps the headline', async () => {
    const forge = seeded()
    await forge.setAutoMerge('/ws', 1, true, options)
    const before = forge.armedAutoMerge(1)!
    forge.editPr(1, { body: 'New description' })
    expect(await forge.setAutoMerge('/ws', 1, true, options)).toEqual({ kind: 'applied' })
    const armed = forge.armedAutoMerge(1)!
    expect(armed.headline).toBe(before.headline)
    expect(armed.body.startsWith('New description')).toBe(true)
    expect(trailers(armed.body)).toEqual([trailer])
    expect(armed.body.trimEnd().endsWith(trailer)).toBe(true)
  })

  test('a merge-commit request is replaced with the identity squash', async () => {
    const forge = seeded()
    forge.armAutoMerge(1, { method: 'MERGE', headline: 'Fake PR #1 (#1)', body: `\n\n${trailer}` })
    expect(await forge.setAutoMerge('/ws', 1, true, options)).toEqual({ kind: 'applied' })
    expect(forge.armedAutoMerge(1)).toEqual(forge.expectedIdentity(1, options))
    expect(lastCall(forge).changed).toBe(true)
  })

  test('a missing or wrong trailer is replaced with exactly one correct trailer', async () => {
    for (const body of ['', 'Autobuild-Build: other']) {
      const forge = seeded()
      forge.armAutoMerge(1, { method: 'SQUASH', headline: 'Fake PR #1 (#1)', body })
      expect(await forge.setAutoMerge('/ws', 1, true, options)).toEqual({ kind: 'applied' })
      expect(trailers(forge.armedAutoMerge(1)!.body)).toEqual([trailer])
    }
  })

  test('revoked consent or a gate deferral leaves the stale request armed', async () => {
    const stale = { method: 'MERGE' as const, headline: 'Merge', body: '' }
    const revoked = seeded()
    revoked.armAutoMerge(1, stale)
    expect(
      await revoked.setAutoMerge('/ws', 1, true, { ...options, canApply: async () => false }),
    ).toEqual({ kind: 'deferred' })
    expect(revoked.armedAutoMerge(1)).toEqual(stale)

    const gated = seeded()
    gated.armAutoMerge(1, stale)
    gated.setGateProbeError(1, 'gate unreadable')
    let consulted = false
    const result = await gated.setAutoMerge('/ws', 1, true, {
      ...options,
      canApply: async () => (consulted = true),
    })
    expect(result.kind).toBe('deferred')
    expect(consulted).toBe(false)
    expect(gated.armedAutoMerge(1)).toEqual(stale)
  })

  test('fresh defaults come from the edited PR body, never the merge message', async () => {
    const forge = new FakeForge()
    await forge.openPr(prOpts({ mergeMessage: 'Deposited merge message' }))
    forge.setPrState(1, { state: 'open', mergeable: true })
    await forge.setAutoMerge('/ws', 1, true, options)
    expect(forge.armedAutoMerge(1)!.body.startsWith('Body text')).toBe(true)
    forge.editPr(1, { body: 'Edited body' })
    await forge.setAutoMerge('/ws', 1, true, options)
    const armed = forge.armedAutoMerge(1)!
    expect(armed.headline).toBe('Fix login (#1)')
    expect(armed.body.startsWith('Edited body')).toBe(true)
    expect(armed.body).not.toContain('Deposited merge message')
  })

  test('a seeded legacy arm reads as matching; a modelled arm never does', async () => {
    const legacy = seeded()
    legacy.setAutoMergeState(1, true)
    expect(legacy.armedAutoMerge(1)).toBeUndefined()
    expect(await legacy.setAutoMerge('/ws', 1, true, options)).toEqual({ kind: 'applied' })
    expect(lastCall(legacy).changed).toBe(false)

    const modelled = seeded()
    modelled.armAutoMerge(1, { method: 'SQUASH', headline: 'wrong', body: trailer })
    await modelled.setAutoMerge('/ws', 1, true, options)
    expect(lastCall(modelled).changed).toBe(true)
    expect(modelled.armedAutoMerge(1)).toEqual(modelled.expectedIdentity(1, options))
  })

  test('disabling clears the modelled request', async () => {
    const forge = seeded()
    await forge.setAutoMerge('/ws', 1, true, options)
    await forge.setAutoMerge('/ws', 1, false)
    expect(forge.armedAutoMerge(1)).toBeUndefined()
  })
})
