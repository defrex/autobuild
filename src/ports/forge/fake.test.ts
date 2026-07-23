import { describe, expect, test } from 'bun:test'
import type { Forge, PrState } from '../types'
import {
  describeForgeContract,
  type ForgeContractFactory,
} from './contract'
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
  const forge = new FakeForge({
    headSha,
    mergeSha: landingSha,
    gatePresence: opts.gated ? 'present' : 'absent',
  })
  return {
    forge,
    workspacePath: `/fake/forge-contract/${crypto.randomUUID()}`,
    head: `ab/contract-head-${crypto.randomUUID()}`,
    base: `contract-base-${crypto.randomUUID()}`,
    title: `Forge contract ${crypto.randomUUID()}`,
    body: 'Autobuild Forge contract fixture',
    controls: {
      remoteHead: async (branch) => {
        if (!forge.pushes.some((push) => push.branch === branch)) {
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
      nativeAutoMergeEnabled: async (number) =>
        forge.isAutoMergeEnabled(number),
      commentExists: async (number, body) =>
        forge.comments.some(
          (comment) => comment.number === number && comment.body === body,
        ),
      mergeSha: async () => landingSha,
      trackPr: () => {},
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
    expect(await forge.getPrState('/ws/a', number)).toEqual({
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
    expect(await forge.getPrState('/ws/a', number)).toEqual({
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
    expect(await forge.getPrState('/ws/a', 99)).toEqual(state)
    await forge.commentOnPr('/ws/a', 99, 'seeded')
    expect(forge.comments).toEqual([
      { workspacePath: '/ws/a', number: 99, body: 'seeded' },
    ])
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

  test('guarded squash rejects a moved head and never journals or lands it', async () => {
    const forge = new FakeForge({ gatePresence: 'absent', headSha: 'old-head' })
    const pr = await forge.openPr(prOpts())
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    const candidate = await forge.setAutoMerge('/ws/a', pr.number, true)
    expect(candidate).toEqual({ kind: 'ungated', headSha: 'old-head' })
    forge.setPrHeadSha(pr.number, 'new-head')

    await expect(
      forge.squashMerge('/ws/a', pr.number, 'old-head'),
    ).rejects.toThrow('head changed')
    expect(forge.squashMergeCalls).toEqual([])
    expect(await forge.getPrState('/ws/a', pr.number)).toEqual({
      state: 'open',
      mergeable: true,
    })
  })

  test('gate-probe errors and unexplained blockers surface instead of self-merging', async () => {
    const forge = new FakeForge({ gatePresence: 'absent' })
    const pr = await forge.openPr(prOpts())
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    forge.setGateProbeError(pr.number, 'rulesets forbidden')
    await expect(forge.setAutoMerge('/ws/a', pr.number, true)).rejects.toThrow(
      'rulesets forbidden',
    )

    forge.setGatePresence(pr.number, 'absent')
    forge.setMergeStateStatus(pr.number, 'BLOCKED')
    await expect(forge.setAutoMerge('/ws/a', pr.number, true)).rejects.toThrow(
      'BLOCKED',
    )
    expect(forge.squashMergeCalls).toEqual([])
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
    await expect(forge.commentOnPr('/ws/a', 7, 'hi')).rejects.toThrow(
      'unknown PR #7',
    )
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
    await expect(forge.prAttachments!.upload(request)).rejects.toThrow(
      'upload unavailable',
    )
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
