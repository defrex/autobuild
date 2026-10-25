import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedStore, BUILD, BRANCH } from '../cli/testkit'
import { bunExec, GitHubForge } from '../ports/forge/github'
import { LocalGitForge } from '../ports/forge/local-git'
import { DISPATCHER, KERNEL } from '../events/envelope'
import {
  archiveTips,
  prepareRestack,
  publishRestack,
  validateRestack,
  retainReplay,
} from './reconcile-restack'
import { FakeForge } from '../ports/forge/fake'
import { humanActor } from '../events/envelope'
import { buildTrailers } from './build-identity'

const mkdtemp = ownTempDirectories(afterEach)

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
      const unavailable = ['e'.repeat(40), 'f'.repeat(40)]
      if (mode === 'clean') {
        // One publication was declared lost, another was abandoned at release
        // without its loss fact. Neither object ever reached the shared repo.
        for (const [index, sha] of unavailable.entries()) {
          const request = await store.append(BUILD, {
            actor: (await import('../events/envelope')).agentActor('implement', `lost-${index}`),
            type: 'publication.requested',
            payload: {
              operation: 'implement',
              branch: BRANCH,
              sha,
              base,
              round: 1,
              artifact: { kind: 'implement-notes', rev: 0 },
            },
          })
          if (index === 0)
            await store.append(BUILD, {
              actor: DISPATCHER,
              type: 'publication.lost',
              payload: {
                request: request.seq,
                operation: 'implement',
                branch: BRANCH,
                sha,
                reason: 'workspace released before publication',
              },
            })
        }
        await store.append(BUILD, { actor: KERNEL, type: 'workspace.released', payload: {} })
        await store.append(BUILD, {
          actor: KERNEL,
          type: 'workspace.provisioned',
          payload: {
            provider: 'git-worktree',
            ref: cwd,
            branch: BRANCH,
            base: { source: 'existing', sha: base },
          },
        })
      }
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
        expect(
          (await store.getEvents(BUILD)).findLast((e) => e.type === 'reconcile.replayed')?.payload,
        ).toMatchObject({ conflicted: true, files: ['shared'] })
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
        await retainReplay(deps, head, target)
        await git(['checkout', '-q', BRANCH])
        const replacement = `${cwd}-replacement`
        try {
          await git(['clone', '--no-local', '-q', cwd, replacement])
          const absent = await bunExec(['git', 'cat-file', '-e', `${head}^{commit}`], {
            cwd: replacement,
          })
          expect(absent.exitCode).not.toBe(0)
          await prepareRestack({ ...deps, workspacePath: replacement }, input)
          const restored = await bunExec(['git', 'rev-parse', 'HEAD'], { cwd: replacement })
          expect(restored.stdout.trim()).toBe(head)
          await validateRestack({ ...deps, workspacePath: replacement }, transaction, head)
        } finally {
          await rm(replacement, { recursive: true, force: true })
        }
        await git(['checkout', '--detach', head])
      }
      const native = new FakeForge()
      native.setPrState(1, { state: 'open', mergeable: true })
      await native.setAutoMerge(cwd, 1, true)
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'finalize.completed',
        payload: { pr: { number: 1, url: 'https://forge/1', headSha: oldHead } },
      })
      const decision = await store.append(BUILD, {
        actor: KERNEL,
        type: 'landing.decided',
        payload: {
          candidate: { head: oldHead, parent: base, cycle: '1' },
          from: 'leaf',
          into: { kind: 'root' },
          labels: [],
          mode: 'consent',
          rule: { default: true },
        },
      })
      const consent = await store.append(BUILD, {
        actor: humanActor('operator'),
        type: 'build.land-requested',
        payload: { decisionSeq: decision.seq },
      })
      deps.forge.getPrState = native.getPrState.bind(native)
      deps.forge.setAutoMerge = native.setAutoMerge.bind(native)
      const rewrite = deps.forge.rewrite!
      Object.defineProperty(deps.forge, 'rewrite', { value: rewrite })
      const replace = rewrite.replace.bind(rewrite)
      let crashAfterCancel = mode === 'clean'
      deps.forge.rewrite!.replace = async (input) => {
        expect(native.isAutoMergeEnabled(1)).toBe(false)
        expect(
          (await store.getEvents(BUILD)).findLast((e) => e.type === 'landing.native-applied')
            ?.payload,
        ).toMatchObject({ enabled: false, operation: intent.id })
        if (crashAfterCancel) {
          crashAfterCancel = false
          throw new Error('crash after cancellation')
        }
        return replace(input)
      }
      const setter = deps.forge.setAutoMerge
      deps.forge.setAutoMerge = async () => ({ kind: 'deferred' })
      await expect(publishRestack(deps, intent)).rejects.toThrow('cancellation unconfirmed')
      expect(await git(['rev-parse', BRANCH])).toBe(oldHead)
      deps.forge.setAutoMerge = setter
      if (mode === 'clean') {
        await expect(publishRestack(deps, intent)).rejects.toThrow('crash after cancellation')
        expect(await git(['rev-parse', BRANCH])).toBe(oldHead)
      }
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
      const finalEvents = await store.getEvents(BUILD)
      expect(finalEvents.findLast((e) => e.type === 'build.land-requested')?.seq).toBe(consent.seq)
      expect(finalEvents.filter((e) => e.type === 'build.hold-requested')).toEqual([])
      expect(native.isAutoMergeEnabled(1)).toBe(false)
      const archives = await archiveTips(deps)
      expect(archives.some((entry) => entry.sha === oldHead)).toBe(true)
      for (const sha of unavailable) expect(archives.some((entry) => entry.sha === sha)).toBe(false)
      // A failed post-reconcile verifier can return to implement. Ordinary
      // publication from that same workspace must remain usable.
      expect(await git(['symbolic-ref', '--short', 'HEAD'])).toBe(BRANCH)
      const fix = await file('verify-fix', 'fix the failed verifier\n')
      await deps.forge.pushBranch(cwd, BRANCH)
      expect(await git(['rev-parse', BRANCH])).toBe(fix)
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

for (const local of [true, false]) {
  test(`${local ? 'local-git' : 'GitHub transport'} records a successful CAS overtaken before readback`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ab-overtaken-'))
    const remote = `${cwd}.git`
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
      const old = await commit('build-change')
      await git(['checkout', '-q', 'main'])
      const target = await commit('upstream')
      await git(['checkout', '-q', BRANCH])
      if (!local) {
        await git(['init', '--bare', '-q', remote])
        await git(['remote', 'add', 'origin', remote])
        await git(['push', '-q', 'origin', BRANCH])
      }
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
        type: 'finalize.completed',
        payload: {
          pr: { number: 1, url: 'https://forge.test/pr/1', headSha: old },
        },
      })
      await store.append(BUILD, {
        actor: DISPATCHER,
        type: 'pr.conflicted',
        payload: { baseSha: target },
      })
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'reconcile.started',
        payload: { attempt: 1, baseSha: target },
      })
      let overtake = true
      let observed = ''
      const exec: typeof bunExec = async (cmd, options) => {
        const result = await bunExec(cmd, options)
        const cas = local
          ? cmd[1] === 'update-ref' && cmd[2] === `refs/heads/${BRANCH}`
          : cmd[1] === 'push' && cmd.includes(`--force-with-lease=refs/heads/${BRANCH}:${old}`)
        if (overtake && cas && result.exitCode === 0) {
          overtake = false
          const candidate = await git(['rev-parse', 'HEAD'])
          const tree = await git(['rev-parse', `${candidate}^{tree}`])
          observed = await git(['commit-tree', tree, '-p', candidate, '-m', 'competing writer'])
          await git(
            local
              ? ['update-ref', `refs/heads/${BRANCH}`, observed, candidate]
              : ['push', '-q', 'origin', `${observed}:refs/heads/${BRANCH}`],
          )
        }
        return result
      }
      const forge = local ? new LocalGitForge({ exec }) : new GitHubForge({ exec })
      forge.getPrState = async () => ({ state: 'open', mergeable: true })
      forge.setAutoMerge = async () => ({ kind: 'applied' as const })
      const deps = { store, slug: BUILD, workspacePath: cwd, exec: bunExec, forge }
      const transaction = await prepareRestack(deps, {
        attempt: 1,
        branch: BRANCH,
        oldBase: base,
        targetBase: target,
        id: 'rewrite-1',
      })
      const candidate = await git(['rev-parse', 'HEAD'])
      const intent = {
        ...transaction,
        headSha: candidate,
        conflicted: false,
        artifact: { kind: 'reconcile-notes', rev: 0 },
      }
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'reconcile.publish-intended',
        payload: intent,
      })
      const append = store.append.bind(store)
      let loseReceipt = true
      store.append = async (slug, event) => {
        if (loseReceipt && event.type === 'reconcile.rewritten') {
          loseReceipt = false
          throw new Error('crash before overtaken write receipt')
        }
        return append(slug, event)
      }
      await expect(publishRestack(deps, intent)).rejects.toThrow(
        'crash before overtaken write receipt',
      )
      expect(
        (await store.getEvents(BUILD)).some((event) => event.type === 'reconcile.rewritten'),
      ).toBe(false)
      // The failed durable receipt cannot be reconstructed from ancestry.
      expect(await publishRestack(deps, intent)).toEqual({
        kind: 'lease-mismatch',
        actual: observed,
      })
      expect(
        (await store.getEvents(BUILD)).filter((e) => e.type === 'reconcile.rewritten'),
      ).toHaveLength(0)
      expect((await store.getEvents(BUILD)).some((e) => e.type === 'reconcile.completed')).toBe(
        false,
      )
      const archive = `refs/autobuild/archive/${BUILD}/${candidate}`
      if (local) expect(await git(['show', `${archive}:build-change`])).toBe('build-change')
      else expect(await git(['ls-remote', 'origin', archive])).toContain(candidate)
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(remote, { recursive: true, force: true })
    }
  })
}

for (const stage of ['prepared', 'conflicted'] as const) {
  test(`replacement remote sandbox restores the exact ${stage} change and archives it before publication`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-replacement-'))
    let cwd = join(root, 'first')
    const remote = join(root, 'origin.git')
    async function git(args: string[]) {
      const result = await bunExec(['git', ...args], { cwd })
      if (result.exitCode !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    async function configure() {
      await git(['config', 'user.name', 'Test'])
      await git(['config', 'user.email', 'test@example.invalid'])
      await git(['config', 'commit.gpgsign', 'false'])
    }
    async function provision(store: Awaited<ReturnType<typeof seedStore>>, base: string) {
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'workspace.provisioned',
        payload: {
          provider: 'vercel-sandbox',
          remote: true,
          ref: cwd,
          branch: BRANCH,
          base: { source: 'remote', sha: base },
        },
      })
    }
    try {
      const init = await bunExec(['git', 'init', '-q', '-b', 'main', cwd], { cwd: root })
      expect(init.exitCode).toBe(0)
      await configure()
      await writeFile(join(cwd, 'shared'), 'base\n')
      await git(['add', '.'])
      await git(['commit', '-qm', 'base'])
      const base = await git(['rev-parse', 'HEAD'])
      await git(['checkout', '-qb', BRANCH])
      await writeFile(join(cwd, 'shared'), 'build\n')
      await git(['commit', '-qam', 'build'])
      const old = await git(['rev-parse', 'HEAD'])
      await git(['checkout', '-q', 'main'])
      await writeFile(join(cwd, 'shared'), 'upstream\n')
      await git(['commit', '-qam', 'upstream'])
      const target = await git(['rev-parse', 'HEAD'])
      await git(['init', '--bare', '-q', remote])
      await git(['remote', 'add', 'origin', remote])
      await git(['push', '-q', 'origin', 'main', BRANCH])
      await git(['checkout', '-q', BRANCH])
      const store = await seedStore()
      await store.putArtifact(BUILD, { kind: 'pr-description', content: "Build's change\n" })
      await provision(store, base)
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'reconcile.started',
        payload: { attempt: 1, baseSha: target },
      })
      let interrupt = stage === 'prepared'
      const deps = () => ({
        store,
        slug: BUILD,
        workspacePath: cwd,
        exec: async (...args: Parameters<typeof bunExec>) => {
          if (interrupt && args[0][1] === 'checkout' && args[0][2] === '--detach') {
            interrupt = false
            throw new Error('sandbox lost immediately after prepared')
          }
          return bunExec(...args)
        },
        forge: new GitHubForge({ exec: bunExec }),
      })
      const input = {
        attempt: 1,
        branch: BRANCH,
        oldBase: base,
        targetBase: target,
        id: 'replacement',
      }
      if (stage === 'prepared')
        await expect(prepareRestack(deps(), input)).rejects.toThrow(
          'sandbox lost immediately after prepared',
        )
      else await prepareRestack(deps(), input)
      const prepared = (await store.getEvents(BUILD)).findLast(
        (e) => e.type === 'reconcile.prepared',
      )
      if (prepared?.type !== 'reconcile.prepared') throw new Error('missing prepared transaction')
      const transaction = prepared.payload
      if (stage === 'conflicted') expect(await git(['ls-files', '-u'])).not.toBe('')
      expect(await git(['ls-remote', 'origin', `refs/autobuild/archive/${BUILD}/*`])).toBe('')
      await store.append(BUILD, { actor: KERNEL, type: 'workspace.released', payload: {} })
      await rm(cwd, { recursive: true, force: true })
      cwd = join(root, 'replacement')
      expect(
        (
          await bunExec(['git', 'clone', '-q', '--no-local', '--branch', BRANCH, remote, cwd], {
            cwd: root,
          })
        ).exitCode,
      ).toBe(0)
      await configure()
      await provision(store, base)
      expect(
        (await bunExec(['git', 'cat-file', '-e', transaction.changeSha], { cwd })).exitCode,
      ).not.toBe(0)
      expect(await prepareRestack(deps(), input)).toEqual(transaction)
      expect(await git(['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(transaction.changeSha)
      expect(await git(['rev-parse', 'HEAD'])).toBe(target)
      expect(await git(['rev-parse', BRANCH])).toBe(old)
      await writeFile(join(cwd, 'shared'), 'resolved\n')
      await git(['add', 'shared'])
      await git(['cherry-pick', '--continue'])
      const headSha = await git(['rev-parse', 'HEAD'])
      const intent = {
        ...transaction,
        headSha,
        conflicted: true,
        artifact: { kind: 'reconcile-notes', rev: 0 },
      }
      await store.append(BUILD, {
        actor: KERNEL,
        type: 'reconcile.publish-intended',
        payload: intent,
      })
      expect(await publishRestack(deps(), intent)).toEqual({ kind: 'published' })
      expect(
        await git([
          'ls-remote',
          'origin',
          `refs/autobuild/archive/${BUILD}/${transaction.changeSha}`,
        ]),
      ).toContain(transaction.changeSha)
      expect(await git(['show', '-s', '--format=%P', headSha])).toBe(target)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const automatic of [true, false]) {
  test(`${automatic ? 'automatic restack' : 'reconcile'} publishes with untracked evidence`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ab-untracked-'))
    async function git(args: string[]) {
      const result = await bunExec(['git', ...args], { cwd })
      if (result.exitCode !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    async function commit(name: string, content: string) {
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
      const base = await commit('.gitignore', 'ignored-scratch\n')
      await git(['checkout', '-qb', BRANCH])
      await commit('feature', 'feature\n')
      await git(['checkout', '-q', 'main'])
      const target = await commit('upstream', 'upstream\n')
      await git(['checkout', '-q', BRANCH])
      const paths = [' experiments probe \n.html', 'experiments_probe.html']
      for (const path of [...paths, 'ignored-scratch'])
        await writeFile(join(cwd, path), 'scratch bytes')
      const store = await seedStore()
      await store.putArtifact(BUILD, {
        kind: 'pr-description',
        content: 'Build change\n',
      })
      if (!automatic)
        await store.append(BUILD, {
          actor: KERNEL,
          type: 'reconcile.started',
          payload: { attempt: 1, baseSha: target },
        })
      const deps = {
        store,
        slug: BUILD,
        workspacePath: cwd,
        exec: bunExec,
        forge: new LocalGitForge(),
        ...(automatic
          ? {
              automatic: {
                trigger: 'verify-entry' as const,
                cycle: 1,
                observation: 1,
                message: `Build change\n\nAutobuild-Build: ${BUILD}\n`,
              },
            }
          : {}),
      }
      const transaction = await prepareRestack(deps, {
        attempt: 1,
        branch: BRANCH,
        oldBase: base,
        targetBase: target,
        id: 'untracked-1',
      })
      const headSha = await git(['rev-parse', 'HEAD'])
      const intent = {
        ...transaction,
        headSha,
        conflicted: false,
        artifact: { kind: 'reconcile-notes', rev: 0 },
      }
      if (deps.automatic) {
        const { attempt: _, ...prepared } = transaction
        await store.append(BUILD, {
          actor: KERNEL,
          type: 'restack.publish-intended',
          payload: { ...prepared, ...deps.automatic, headSha },
        })
      } else {
        await store.append(BUILD, {
          actor: KERNEL,
          type: 'reconcile.publish-intended',
          payload: intent,
        })
      }
      await validateRestack(deps, transaction, headSha)
      expect(
        (await store.getEvents(BUILD)).filter((e) => e.type === 'observation.recorded'),
      ).toHaveLength(0)
      const replace = deps.forge.rewrite!.replace.bind(deps.forge.rewrite)
      let replacements = 0
      deps.forge.rewrite!.replace = async (input) => {
        replacements++
        return replace(input)
      }
      for (const staged of [false, true]) {
        await writeFile(join(cwd, 'feature'), 'tracked dirt')
        if (staged) await git(['add', 'feature'])
        await expect(publishRestack(deps, intent)).rejects.toThrow(
          'reconcile publication requires a clean worktree',
        )
        expect(replacements).toBe(0)
        await git(['reset', '--hard', headSha])
      }
      const exec = deps.exec
      deps.exec = async (cmd, options) => {
        if (cmd.includes('--others')) throw new Error('enumeration failed')
        return exec(cmd, options)
      }
      await expect(publishRestack(deps, intent)).rejects.toThrow('enumeration failed')
      deps.exec = exec
      const append = store.append.bind(store)
      store.append = async (slug, event) => {
        if (event.type === 'observation.recorded') throw new Error('observation deposit failed')
        return append(slug, event)
      }
      await expect(publishRestack(deps, intent)).rejects.toThrow('observation deposit failed')
      store.append = append
      expect(replacements).toBe(0)
      expect(await publishRestack(deps, intent)).toEqual({ kind: 'published' })
      expect(await publishRestack(deps, intent)).toEqual({ kind: 'published' })
      expect(await git(['rev-parse', BRANCH])).toBe(headSha)
      for (const path of paths) {
        expect(await readFile(join(cwd, path), 'utf8')).toBe('scratch bytes')
        expect(
          (
            await bunExec(['git', 'cat-file', '-e', `${headSha}:${path}`], {
              cwd,
            })
          ).exitCode,
        ).not.toBe(0)
      }
      let observations = (await store.getEvents(BUILD)).filter(
        (e) => e.type === 'observation.recorded',
      )
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({
        actor: KERNEL,
        payload: {
          kind: 'followup',
          files: paths,
          refs: [automatic ? 'restack:untracked-1' : 'reconcile:untracked-1', headSha],
        },
      })
      await writeFile(join(cwd, 'another probe'), 'more scratch')
      await publishRestack(deps, intent)
      observations = (await store.getEvents(BUILD)).filter((e) => e.type === 'observation.recorded')
      expect(observations).toHaveLength(2)
      await publishRestack(deps, { ...intent, id: 'untracked-2' })
      expect(
        (await store.getEvents(BUILD)).filter((e) => e.type === 'observation.recorded'),
      ).toHaveLength(3)
      for (const path of [...paths, 'another probe']) await rm(join(cwd, path))
      await publishRestack(deps, { ...intent, id: 'clean-3' })
      expect(
        (await store.getEvents(BUILD)).filter((e) => e.type === 'observation.recorded'),
      ).toHaveLength(3)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
}
