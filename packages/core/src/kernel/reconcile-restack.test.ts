import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedStore, BUILD, BRANCH } from '../cli/testkit'
import { bunExec } from '../ports/forge/github'
import { LocalGitForge } from '../ports/forge/local-git'
import { KERNEL } from '../events/envelope'
import { archiveTips, prepareRestack, publishRestack, validateRestack } from './reconcile-restack'
import { buildTrailers } from './build-identity'

for (const mode of ['clean', 'conflict', 'empty'] as const) {
  test(`single-change replay: ${mode}, durable recovery, archives and CAS`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ab-restack-'))
    async function git(args: string[]) {
      const result = await bunExec(['git', ...args], { cwd })
      if (result.exitCode !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    async function file(name: string, content: string) {
      await writeFile(join(cwd, name), content)
      await git(['add', name])
      await git(['commit', '-qm', name])
      return git(['rev-parse', 'HEAD'])
    }
    try {
      await git(['init', '-q', '-b', 'main'])
      await git(['config', 'user.name', 'Test'])
      await git(['config', 'user.email', 'test@example.invalid'])
      await git(['config', 'commit.gpgsign', 'false'])
      const base = await file('shared', 'original\n')
      await git(['checkout', '-qb', BRANCH])
      await file('shared', 'build\n')
      const oldHead = await file('feature', 'feature\n')
      await git(['checkout', '-q', 'main'])
      if (mode === 'conflict') await file('shared', 'upstream\n')
      else if (mode === 'empty') {
        await file('shared', 'build\n')
        await file('feature', 'feature\n')
      } else await file('upstream', 'upstream\n')
      const target = await git(['rev-parse', 'HEAD'])
      await git(['checkout', '-q', BRANCH])
      const store = await seedStore()
      await store.putArtifact(BUILD, {
        kind: 'pr-description',
        content: 'Build change\n\nDescription\n',
      })
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'reconcile.started',
        payload: { attempt: 1, baseSha: target },
      })
      let crashAfterCas = false
      const forgeExec: typeof bunExec = async (cmd, options) => {
        const result = await bunExec(cmd, options)
        if (
          crashAfterCas &&
          cmd[1] === 'update-ref' &&
          cmd[2] === `refs/heads/${BRANCH}` &&
          result.exitCode === 0
        ) {
          crashAfterCas = false
          throw new Error('crash after CAS before rewrite receipt')
        }
        return result
      }
      const deps = {
        store,
        slug: BUILD,
        workspacePath: cwd,
        exec: bunExec,
        forge: new LocalGitForge({ exec: forgeExec }),
      }
      const input = {
        attempt: 1,
        branch: BRANCH,
        oldBase: base,
        targetBase: target,
        id: 'rewrite-1',
      }
      const transaction = await prepareRestack(deps, input)
      expect(await git(['rev-parse', BRANCH])).toBe(oldHead)
      expect(await git(['rev-parse', `${transaction.changeSha}^{tree}`])).toBe(
        await git(['rev-parse', `${oldHead}^{tree}`]),
      )
      if (mode === 'conflict') {
        expect(await git(['ls-files', '-u'])).not.toBe('')
        await writeFile(join(cwd, 'shared'), 'build and upstream\n')
        await git(['add', 'shared'])
        await git(['cherry-pick', '--continue'])
      }
      const head = await git(['rev-parse', 'HEAD'])
      expect(await prepareRestack(deps, input)).toEqual(transaction)
      expect(await git(['rev-parse', 'HEAD'])).toBe(head)
      await validateRestack(deps, transaction, head)
      expect(await git(['show', '-s', '--format=%P', head])).toBe(target)
      expect(buildTrailers(await git(['show', '-s', '--format=%B', head]))).toEqual([BUILD])
      const intent = {
        ...transaction,
        headSha: head,
        conflicted: mode === 'conflict',
        artifact: { kind: 'reconcile-notes', rev: 0 },
      }
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'reconcile.publish-intended',
        payload: intent,
      })
      if (mode === 'clean') {
        crashAfterCas = true
        await expect(publishRestack(deps, intent)).rejects.toThrow('crash after CAS')
        expect(await git(['rev-parse', BRANCH])).toBe(head)
        expect(
          (await store.getEvents(BUILD)).some((event) => event.type === 'reconcile.rewritten'),
        ).toBe(false)
      }
      expect(await publishRestack(deps, intent)).toEqual({ kind: 'published' })
      expect(await publishRestack(deps, intent)).toEqual({ kind: 'published' })
      expect(await git(['rev-parse', BRANCH])).toBe(head)
      expect(
        (await store.getEvents(BUILD)).filter((e) => e.type === 'reconcile.rewritten'),
      ).toHaveLength(1)
      const archives = await archiveTips(deps)
      expect(archives.some((entry) => entry.sha === oldHead)).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
}

test('a branch race preserves external bytes while upstream B2 cannot move the frozen B1 target', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-restack-race-'))
  async function git(args: string[]) {
    const result = await bunExec(['git', ...args], { cwd })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  async function commit(name: string) {
    await writeFile(join(cwd, name), `${name}\n`)
    await git(['add', name])
    await git(['commit', '-qm', name])
    return git(['rev-parse', 'HEAD'])
  }
  try {
    await git(['init', '-q', '-b', 'main'])
    await git(['config', 'user.name', 'Test'])
    await git(['config', 'user.email', 'test@example.invalid'])
    await git(['config', 'commit.gpgsign', 'false'])
    const base = await commit('original')
    await git(['checkout', '-qb', BRANCH])
    await commit('feature')
    await git(['checkout', '-q', 'main'])
    const b1 = await commit('upstream-b1')
    await git(['checkout', '-q', BRANCH])
    const store = await seedStore()
    await store.putArtifact(BUILD, { kind: 'pr-description', content: 'Build change\n' })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'workspace.provisioned',
      payload: {
        provider: 'git-worktree',
        ref: cwd,
        branch: BRANCH,
        base: { source: 'remote', sha: base },
      },
    })
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 1, baseSha: b1 },
    })
    const deps = {
      store,
      slug: BUILD,
      workspacePath: cwd,
      exec: bunExec,
      forge: new LocalGitForge(),
    }
    const first = await prepareRestack(deps, {
      attempt: 1,
      branch: BRANCH,
      oldBase: base,
      targetBase: b1,
      id: 'rewrite-1',
    })
    const candidate = await git(['rev-parse', 'HEAD'])
    const artifact = { kind: 'reconcile-notes', rev: 0 }
    const intent = { ...first, headSha: candidate, conflicted: false, artifact }
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.publish-intended',
      payload: intent,
    })
    // Competing writer builds on the original branch while the resolver stays detached.
    await git(['checkout', '-q', BRANCH])
    const observed = await commit('external-work')
    await git(['checkout', '-q', 'main'])
    const b2 = await commit('upstream-b2')
    await git(['checkout', '--detach', '-q', candidate])
    expect(await publishRestack(deps, intent)).toEqual({ kind: 'lease-mismatch', actual: observed })
    const second = await prepareRestack(deps, {
      attempt: 1,
      branch: BRANCH,
      oldBase: base,
      targetBase: b1,
      oldHead: observed,
      id: 'rewrite-2',
    })
    const head = await git(['rev-parse', 'HEAD'])
    expect(head).not.toBe(candidate)
    expect(await git(['show', `${head}:external-work`])).toBe('external-work')
    expect(await git(['show', '-s', '--format=%P', head])).toBe(b1)
    expect(await git(['ls-tree', '--name-only', head])).not.toContain('upstream-b2')
    const secondIntent = { ...second, headSha: head, conflicted: false, artifact }
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.publish-intended',
      payload: secondIntent,
    })
    expect(await publishRestack(deps, secondIntent)).toEqual({ kind: 'published' })
    await store.append(BUILD, {
      actor: (await import('../events/envelope')).agentActor('reconcile', 's1'),
      type: 'reconcile.completed',
      payload: { headSha: head, rewriteId: second.id, artifact },
    })
    const { verifyDiffBaseReducer } = await import('../processes/build-runner')
    const events = await store.getEvents(BUILD)
    expect(verifyDiffBaseReducer.reduce(events)).toBe(b1)
    let accumulator = verifyDiffBaseReducer.initial()
    for (const event of events) accumulator = verifyDiffBaseReducer.advance(accumulator, [event])
    expect(verifyDiffBaseReducer.finish(accumulator)).toBe(b1)
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'reconcile.started',
      payload: { attempt: 2, baseSha: b2 },
    })
    const next = await prepareRestack(deps, {
      attempt: 2,
      branch: BRANCH,
      oldBase: b1,
      targetBase: b2,
      id: 'rewrite-3',
    })
    expect(await git(['diff', '--name-only', b1, next.changeSha])).toBe('external-work\nfeature')
    await git(['gc', '--prune=now'])
    const archives = await archiveTips(deps)
    for (const entry of archives) expect(await git(['cat-file', '-t', entry.ref])).toBe('commit')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('an older forge plugin is refused before workspace interrogation or mutation', async () => {
  const { FakeForge } = await import('../ports/forge/fake')
  const forge = new FakeForge()
  Object.defineProperty(forge, 'name', { value: 'legacy-plugin' })
  Object.defineProperty(forge, 'rewrite', { value: undefined })
  let commands = 0
  await expect(
    prepareRestack(
      {
        store: await seedStore(),
        slug: BUILD,
        workspacePath: '/unused',
        forge,
        exec: async () => {
          commands += 1
          throw new Error('must not execute')
        },
      },
      {
        attempt: 1,
        branch: BRANCH,
        oldBase: 'a'.repeat(40),
        targetBase: 'b'.repeat(40),
        id: 'rewrite-1',
      },
    ),
  ).rejects.toThrow('legacy-plugin lacks the reconcile rewrite capability')
  expect(commands).toBe(0)
})
