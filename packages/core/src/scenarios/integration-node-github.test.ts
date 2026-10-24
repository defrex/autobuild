import { spawnExec } from '../ports/workspace/git-worktree'
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { makeHarness, happyHandlers, readyTicket, git, commitAll } from './harness'
import { controlBuild } from '../cli/build-control'
import { reduceBuild } from '../kernel/reducer'
import { integrationHeadVerified } from '../kernel/integration-state'

/** Real remote Git refs with the non-local PR API seam. Deliberately omit
 * snapshotBase, as GitHubForge does, so dispatcher publication must fetch. */
async function remoteNode() {
  const h = await makeHarness({
    gatePresence: 'absent',
    handlers: happyHandlers(),
    tickets: [{ ...readyTicket('NODE', { title: 'Remote integration release' }), kind: 'node' }],
  })
  const forge = h.forge
  Object.defineProperty(forge, 'kernelExec', { value: spawnExec })
  forge.remoteBranchSha = async (branch) =>
    (await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], h.origin)).split(
      /\s+/,
    )[0]!
  forge.createNodeBranch = async (branch, sha) => {
    await git(['push', 'origin', `${sha}:refs/heads/${branch}`], h.origin)
    return sha
  }
  forge.compareBranches = async (parent, head) => {
    await git(
      [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/${parent}:refs/autobuild/test-parent`,
        `+refs/heads/${head}:refs/autobuild/test-head`,
      ],
      h.origin,
    )
    return {
      parentSha: await git(['rev-parse', 'refs/autobuild/test-parent'], h.origin),
      headSha: await git(['rev-parse', 'refs/autobuild/test-head'], h.origin),
      ahead: Number(
        await git(
          ['rev-list', '--count', 'refs/autobuild/test-parent..refs/autobuild/test-head'],
          h.origin,
        ),
      ),
    }
  }
  const openPr = forge.openPr.bind(forge)
  forge.openPr = async (input) => {
    forge.setHeadSha(await forge.remoteBranchSha(input.head))
    const pr = await openPr(input)
    forge.setPrState(pr.number, { state: 'open', mergeable: true })
    return pr
  }
  const inspectPr = forge.inspectLandingPr.bind(forge)
  forge.inspectLandingPr = async (cwd, number) => {
    const pr = await inspectPr(cwd, number)
    pr.headSha = await forge.remoteBranchSha(pr.head)
    forge.setPrHeadSha(number, pr.headSha)
    return pr
  }
  const merge = forge.mergeLinearStack.bind(forge)
  let raceDuringMerge = false
  let loseResponse = false
  forge.mergeLinearStack = async (cwd, number, head) => {
    const pr = await forge.inspectLandingPr(cwd, number)
    if (raceDuringMerge)
      await h.advanceRemote(
        { 'raced-parent.txt': 'unverified parent window' },
        'Shared parent raced',
      )
    const parent = await forge.remoteBranchSha(pr.base)
    const verifiedParent = reduceBuild(await h.events((await h.store.listBuilds())[0]!.slug))
      .integration!.cycle!.parent
    const worktree = join(h.tmp, 'server-rebase')
    await git(['fetch', 'origin', pr.base, pr.head], h.origin)
    await git(['worktree', 'add', '--detach', worktree, parent], h.origin)
    let landed: string
    try {
      const commits = (
        await git(['rev-list', '--reverse', `${verifiedParent}..${head}`], h.origin)
      ).split('\n')
      await git(['cherry-pick', ...commits], worktree)
      landed = await git(['rev-parse', 'HEAD'], worktree)
      await git(['push', 'origin', `${landed}:refs/heads/${pr.base}`], worktree)
    } finally {
      await git(['worktree', 'remove', '--force', worktree], h.origin)
    }
    await merge(cwd, number, head)
    forge.setPrState(number, { state: 'merged', sha: landed, headSha: head })
    if (loseResponse) throw new Error('merge response lost after server publication')
    return landed
  }
  await h.dispatcher.tick()
  const node = (await h.store.listBuilds())[0]!
  await git(['fetch', 'origin', node.branch!], h.origin)
  const cwd = join(h.tmp, 'source-stack')
  await git(['worktree', 'add', '--detach', cwd, 'FETCH_HEAD'], h.origin)
  for (const id of ['first-child', 'second-child']) {
    await Bun.write(join(cwd, id), id)
    await Bun.write(join(cwd, 'ok.marker'), 'ok')
    await commitAll(cwd, `Change ${id}\n\nAutobuild-Build: ${id}`)
  }
  await git(['push', 'origin', `HEAD:refs/heads/${node.branch}`], cwd)
  await git(['worktree', 'remove', cwd], h.origin)
  for (let i = 0; i < 3; i++) await h.dispatcher.tick()
  await h.runLatest()
  await h.dispatcher.tick()
  const verified = reduceBuild(await h.events(node.slug))
  expect(integrationHeadVerified(verified, verified.integration!.cycle!.head)).toBe(true)
  await controlBuild({
    store: h.store,
    repo: h.origin,
    slug: node.slug,
    action: { kind: 'land' },
    ticketSource: async () => h.tickets,
  })
  return {
    h,
    node,
    forge,
    setRace: () => {
      raceDuringMerge = true
    },
    loseResponse: () => {
      loseResponse = true
    },
  }
}

test('dispatcher lands non-local roots without snapshotBase and audits the immutable result', async () => {
  const { h, node, forge } = await remoteNode()
  try {
    expect(h.forgeAdapter.snapshotBase).toBeUndefined()
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const state = reduceBuild(await h.events(node.slug))
    expect(forge.linearStackMerges).toHaveLength(1)
    expect(forge.squashMergeCalls).toHaveLength(0)
    expect(state.status).toBe('done')
    expect(state.integration?.landing).toMatchObject({
      provenance: 'kernel',
      fenced: false,
      verified: true,
    })
    expect(state.integration?.audit?.verifiedTree).toBe(state.integration?.audit?.landedTree)
    expect(state.integration?.audit?.identities).toEqual(['first-child', 'second-child'])
  } finally {
    await h.cleanup()
  }
})

test('parent movement before the merge request abandons intent and restacks and verifies again', async () => {
  const { h, node, forge } = await remoteNode()
  try {
    let moved = false
    forge.inspectMergeFreshness = async () => {
      if (!moved) {
        moved = true
        await h.advanceRemote({ 'parent-update.txt': 'new parent' }, 'Parent moved before request')
      }
      return { fenced: false, evidence: ['No enforced freshness'] }
    }
    await h.dispatcher.tick()
    expect(forge.linearStackMerges).toHaveLength(0)
    expect(
      (await h.events(node.slug)).some((event) => event.type === 'integration.abandoned'),
    ).toBe(true)
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const restacked = reduceBuild(await h.events(node.slug))
    expect(restacked.integration?.cycles).toHaveLength(2)
    expect(forge.linearStackMerges).toHaveLength(0)
    await h.runLatest()
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    expect(forge.linearStackMerges).toHaveLength(1)
    expect(reduceBuild(await h.events(node.slug)).status).toBe('done')
  } finally {
    await h.cleanup()
  }
})

test('ambiguous non-local merge response recovers kernel provenance after consent revocation', async () => {
  const { h, node, forge, loseResponse } = await remoteNode()
  try {
    loseResponse()
    expect((await h.dispatcher.tick()).janitorFailed).toBe(1)
    expect(forge.linearStackMerges).toHaveLength(1)
    expect(reduceBuild(await h.events(node.slug)).integration?.landing).toBeUndefined()
    await controlBuild({
      store: h.store,
      repo: h.origin,
      slug: node.slug,
      action: { kind: 'hold' },
    })
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    expect(forge.linearStackMerges).toHaveLength(1)
    expect(reduceBuild(await h.events(node.slug)).integration?.landing?.provenance).toBe('kernel')
    expect(reduceBuild(await h.events(node.slug)).status).toBe('done')
  } finally {
    await h.cleanup()
  }
})

test('an unfenced parent-window race raises audit attention after non-local landing', async () => {
  const { h, node, setRace } = await remoteNode()
  try {
    setRace()
    for (let i = 0; i < 3; i++) await h.dispatcher.tick()
    const state = reduceBuild(await h.events(node.slug))
    expect(state.status).toBe('done')
    expect(state.integration?.audit).toBeDefined()
    expect(state.integration?.audit?.verifiedTree).not.toBe(state.integration?.audit?.landedTree)
    expect(state.openEscalations).toHaveLength(1)
    expect(await git(['show', 'main:raced-parent.txt'], join(h.tmp, 'remote-updater'))).toBe(
      'unverified parent window',
    )
  } finally {
    await h.cleanup()
  }
})

test('waiting landing retries are throttled and recheck reopened children before publication', async () => {
  const { h, node, forge } = await remoteNode()
  try {
    let scans = 0
    let attempts = 0
    const listAll = h.tickets.listAll.bind(h.tickets)
    h.tickets.listAll = async () => {
      scans++
      return listAll()
    }
    forge.mergeLinearStack = async () => {
      attempts++
      throw new Error('retryable provider failure before publication')
    }
    await h.dispatcher.tick()
    expect(attempts).toBe(1)
    expect(scans).toBe(2) // observation and fresh publication sample
    for (let i = 0; i < 20; i++) {
      h.clock.advance(10_000)
      await h.dispatcher.tick()
    }
    expect(attempts).toBe(1)
    expect(scans).toBe(2)
    h.tickets.add({
      ...readyTicket('REOPENED', { title: 'New backlog child' }),
      target: 'NODE',
      state: 'Backlog',
    })
    h.clock.advance(300_000)
    await h.dispatcher.tick()
    expect(attempts).toBe(1)
    expect(scans).toBe(3)
    const state = reduceBuild(await h.events(node.slug))
    expect(state.integration?.observation?.openChildren).toEqual(['REOPENED'])
    expect(state.integration?.intent).toBeUndefined()
    expect(state.integration?.landing).toBeUndefined()
  } finally {
    await h.cleanup()
  }
})
