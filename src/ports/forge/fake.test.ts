import { describe, expect, test } from 'bun:test'
import type { Forge, PrState } from '../types'
import { FakeForge } from './fake'

const prOpts = (over: Partial<Parameters<Forge['openPr']>[0]> = {}) => ({
  workspacePath: '/ws/a',
  head: 'ab/fix-login',
  base: 'main',
  title: 'Fix login',
  body: 'Body text',
  ...over,
})

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

  test('a just-opened PR reads back open with mergeable null', async () => {
    const forge = new FakeForge()
    const { number } = await forge.openPr(prOpts())
    expect(await forge.getPrState('/ws/a', number)).toEqual({
      state: 'open',
      mergeable: null,
    })
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
})
