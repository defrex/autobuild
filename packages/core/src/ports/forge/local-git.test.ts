import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeForgeContract, type ForgeContractFactory } from './contract'
import { bunExec } from './github'
import { LocalGitForge } from './local-git'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  return stdout.trim()
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ab-local-forge-test-'))
  roots.push(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Repository Operator')
  await git(root, 'config', 'user.email', 'operator@example.test')
  await writeFile(join(root, 'shared.txt'), 'base\n')
  await git(root, 'add', 'shared.txt')
  await git(root, 'commit', '-m', 'initial')
  const head = `ab/contract-${crypto.randomUUID()}`
  const workspace = `${root}-build`
  roots.push(workspace)
  await git(root, 'worktree', 'add', '-b', head, workspace, 'main')
  await writeFile(join(workspace, 'feature.txt'), 'feature\n')
  await git(workspace, 'add', 'feature.txt')
  await git(workspace, 'commit', '-m', 'feature')
  return { root, workspace, head, forge: new LocalGitForge({ repoRoot: root }) }
}

const localContractFactory: ForgeContractFactory = async () => {
  const f = await fixture()
  return {
    forge: f.forge,
    nativeAutoMerge: false,
    workspacePath: f.workspace,
    head: f.head,
    base: 'main',
    title: `Local contract ${crypto.randomUUID()}`,
    body: 'Offline local forge contract body',
    controls: {
      remoteHead: async (branch) => git(f.workspace, 'rev-parse', `refs/heads/${branch}`),
      prepareMergeable: async () => {},
      closePr: async () => {
        await git(f.root, 'update-ref', '-d', `refs/heads/${f.head}`)
      },
      makeConflict: async () => {
        await writeFile(join(f.workspace, 'shared.txt'), 'feature conflict\n')
        await git(f.workspace, 'add', 'shared.txt')
        await git(f.workspace, 'commit', '-m', 'feature conflict')
        await writeFile(join(f.root, 'shared.txt'), 'base conflict\n')
        await git(f.root, 'add', 'shared.txt')
        await git(f.root, 'commit', '-m', 'base conflict')
      },
      advanceHead: async () => {
        await writeFile(join(f.workspace, `advance-${crypto.randomUUID()}.txt`), 'advanced\n')
        await git(f.workspace, 'add', '.')
        await git(f.workspace, 'commit', '-m', 'advance head')
        return git(f.workspace, 'rev-parse', 'HEAD')
      },
      nativeAutoMergeEnabled: async () => false,
      commentExists: async (number, body) => {
        const blob = await git(f.root, 'rev-parse', `refs/autobuild/local-git/prs/${number}`)
        const source = await git(f.root, 'cat-file', 'blob', blob)
        return (JSON.parse(source) as { comments: string[] }).comments.includes(body)
      },
      mergeSha: async () => git(f.root, 'rev-parse', 'main'),
      trackPr: () => {},
    },
    cleanup: async () => {
      await rm(f.workspace, { recursive: true, force: true })
      await rm(f.root, { recursive: true, force: true })
    },
  }
}

describeForgeContract('LocalGitForge', localContractFactory)

describe('LocalGitForge', () => {
  test('persists records across instances, snapshots local base, and merges exact squash content', async () => {
    const f = await fixture()
    const description = '# Local merge\n\nExact body for the squash commit.\n'
    await f.forge.pushBranch(f.workspace, f.head)
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'Local merge',
      body: 'Exact body for the squash commit.',
      mergeMessage: description,
    })
    expect(pr.url).toBe(`refs/heads/${f.head}`)
    expect(await git(f.root, 'remote', '-v')).toBe('')

    const fresh = new LocalGitForge()
    expect(
      await fresh.openPr({
        workspacePath: f.root,
        head: f.head,
        base: 'main',
        title: 'retry',
        body: 'retry',
      }),
    ).toEqual(pr)

    const snapshot = await fresh.snapshotBase({
      workspacePath: f.workspace,
      base: 'main',
      destinationRef: 'refs/autobuild/test/base',
    })
    expect(await git(f.root, 'rev-parse', 'refs/autobuild/test/base')).toBe(snapshot)

    await git(f.root, 'config', 'commit.gpgsign', 'true')
    const candidate = await fresh.setAutoMerge(f.workspace, pr.number, true)
    expect(candidate).toEqual({ kind: 'ungated', headSha: pr.headSha })
    await fresh.squashMerge(f.workspace, pr.number, pr.headSha)
    const landed = await git(f.root, 'rev-parse', 'main')
    expect(await fresh.getPrState(f.root, pr.number)).toEqual({ state: 'merged', sha: landed })
    expect(await git(f.root, 'show', '-s', '--format=%P', landed)).toBe(snapshot)
    expect(await git(f.root, 'show', '-s', '--format=%B', landed)).toBe(description.trimEnd())
    expect(await git(f.root, 'show', '-s', '--format=%an <%ae>%n%cn <%ce>', landed)).toBe(
      'Repository Operator <operator@example.test>\nRepository Operator <operator@example.test>',
    )
    expect(await git(f.root, 'cat-file', '-p', landed)).not.toContain('gpgsig ')
    expect(await git(f.root, 'status', '--porcelain')).toBe('')
    expect(await git(f.root, 'rev-parse', `refs/heads/${f.head}`)).toBe(pr.headSha)
  })

  test('missing Git identity defers without merge and retries under the configured identity', async () => {
    const f = await fixture()
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'identity retry',
      body: '',
    })
    const before = await git(f.root, 'rev-parse', 'main')
    await git(f.root, 'config', 'user.name', '')
    await git(f.root, 'config', 'user.email', '')

    const deferred = await f.forge.setAutoMerge(f.workspace, pr.number, true)
    expect(deferred.kind).toBe('deferred')
    if (deferred.kind !== 'deferred') throw new Error('expected identity deferral')
    expect(deferred.reason?.code).toBe('local-git-identity-missing')
    expect(deferred.reason?.detail).toContain('git config user.name')
    expect(deferred.reason?.detail).toContain('git config user.email')
    expect(deferred.reason?.detail).toContain('GIT_AUTHOR_IDENT')
    expect(deferred.reason?.detail).toContain('GIT_COMMITTER_IDENT')
    expect(await git(f.root, 'rev-parse', 'main')).toBe(before)
    expect(await f.forge.getPrState(f.root, pr.number)).toEqual({ state: 'open', mergeable: true })

    await git(f.root, 'config', 'user.name', 'Configured Operator')
    await git(f.root, 'config', 'user.email', 'configured@example.test')
    expect(await f.forge.setAutoMerge(f.workspace, pr.number, true)).toEqual({
      kind: 'ungated',
      headSha: pr.headSha,
    })
    await f.forge.squashMerge(f.workspace, pr.number, pr.headSha)
    const landed = await git(f.root, 'rev-parse', 'main')
    expect(await f.forge.getPrState(f.root, pr.number)).toEqual({ state: 'merged', sha: landed })
    expect(await git(f.root, 'show', '-s', '--format=%an <%ae>%n%cn <%ce>', landed)).toBe(
      'Configured Operator <configured@example.test>\nConfigured Operator <configured@example.test>',
    )
  })

  test('compatible base advances remain mergeable and conflicting advances do not', async () => {
    const compatible = await fixture()
    const pr = await compatible.forge.openPr({
      workspacePath: compatible.workspace,
      head: compatible.head,
      base: 'main',
      title: 'compatible',
      body: '',
    })
    await writeFile(join(compatible.root, 'base-only.txt'), 'base advance\n')
    await git(compatible.root, 'add', '.')
    await git(compatible.root, 'commit', '-m', 'compatible base advance')
    expect(await compatible.forge.getPrState(compatible.root, pr.number)).toEqual({
      state: 'open',
      mergeable: true,
    })

    const conflict = await fixture()
    await writeFile(join(conflict.workspace, 'shared.txt'), 'head\n')
    await git(conflict.workspace, 'add', '.')
    await git(conflict.workspace, 'commit', '-m', 'head side')
    const conflictPr = await conflict.forge.openPr({
      workspacePath: conflict.workspace,
      head: conflict.head,
      base: 'main',
      title: 'conflict',
      body: '',
    })
    await writeFile(join(conflict.root, 'shared.txt'), 'base\nchanged\n')
    await git(conflict.root, 'add', '.')
    await git(conflict.root, 'commit', '-m', 'base side')
    expect(await conflict.forge.getPrState(conflict.root, conflictPr.number)).toEqual({
      state: 'open',
      mergeable: false,
    })
  })

  test('merges over non-overlapping tracked, staged, and untracked work without cleaning it', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'index-only.txt'), 'index base\n')
    await git(f.root, 'add', 'index-only.txt')
    await git(f.root, 'commit', '-m', 'advance base with index-only path')
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'carry operator work',
      body: '',
    })
    await writeFile(join(f.root, 'shared.txt'), 'operator edit\n')
    await writeFile(join(f.root, 'index-only.txt'), 'staged operator edit\n')
    await git(f.root, 'add', 'index-only.txt')
    await writeFile(join(f.root, 'scratch.txt'), 'operator scratch\n')

    expect(await f.forge.setAutoMerge(f.workspace, pr.number, true)).toEqual({
      kind: 'ungated',
      headSha: pr.headSha,
    })
    await f.forge.squashMerge(f.workspace, pr.number, pr.headSha)
    const landed = await git(f.root, 'rev-parse', 'main')
    expect(await f.forge.getPrState(f.root, pr.number)).toEqual({ state: 'merged', sha: landed })
    expect(await Bun.file(join(f.root, 'shared.txt')).text()).toBe('operator edit\n')
    expect(await Bun.file(join(f.root, 'index-only.txt')).text()).toBe('staged operator edit\n')
    expect(await Bun.file(join(f.root, 'scratch.txt')).text()).toBe('operator scratch\n')
    expect(await git(f.root, 'status', '--porcelain')).toContain('M shared.txt')
    expect(await git(f.root, 'status', '--porcelain')).toContain('M  index-only.txt')
    expect(await git(f.root, 'status', '--porcelain')).toContain('?? scratch.txt')
    expect(await git(f.root, 'diff', '--cached', '--', 'index-only.txt')).toContain(
      'staged operator edit',
    )
    expect(await git(f.root, 'diff', '--cached', '--', 'feature.txt')).toBe('')
    expect(await git(f.root, 'diff', '--', 'feature.txt')).toBe('')
    expect(await Bun.file(join(f.root, 'feature.txt')).text()).toBe('feature\n')
  })

  test('tracked and untracked merge collisions defer with a path and retry after cleanup', async () => {
    for (const collision of ['tracked', 'untracked'] as const) {
      const f = await fixture()
      if (collision === 'tracked') {
        await writeFile(join(f.workspace, 'shared.txt'), 'merged shared\n')
        await git(f.workspace, 'add', 'shared.txt')
      } else {
        await writeFile(join(f.workspace, 'added.txt'), 'merged add\n')
        await git(f.workspace, 'add', 'added.txt')
      }
      await git(f.workspace, 'commit', '-m', `${collision} collision merge`)
      const pr = await f.forge.openPr({
        workspacePath: f.workspace,
        head: f.head,
        base: 'main',
        title: `${collision} collision`,
        body: '',
      })
      const before = await git(f.root, 'rev-parse', 'main')
      const path = collision === 'tracked' ? 'shared.txt' : 'added.txt'
      await writeFile(join(f.root, path), 'operator work\n')

      const first = await f.forge.setAutoMerge(f.workspace, pr.number, true)
      expect(first.kind).toBe('deferred')
      if (first.kind !== 'deferred') throw new Error('expected checkout deferral')
      expect(first.reason).toMatchObject({ code: 'local-base-checkout-dirty' })
      expect(first.reason?.detail).toContain(path)
      expect(await f.forge.setAutoMerge(f.workspace, pr.number, true)).toEqual(first)
      expect(await git(f.root, 'rev-parse', 'main')).toBe(before)
      expect(await Bun.file(join(f.root, path)).text()).toBe('operator work\n')

      if (collision === 'tracked') await git(f.root, 'checkout', '--', path)
      else await rm(join(f.root, path))
      const candidate = await f.forge.setAutoMerge(f.workspace, pr.number, true)
      expect(candidate).toEqual({ kind: 'ungated', headSha: pr.headSha })
      await f.forge.squashMerge(f.workspace, pr.number, pr.headSha)
      const landed = await git(f.root, 'rev-parse', 'main')
      expect(await f.forge.getPrState(f.root, pr.number)).toEqual({ state: 'merged', sha: landed })
      expect(await Bun.file(join(f.root, path)).text()).toBe(
        collision === 'tracked' ? 'merged shared\n' : 'merged add\n',
      )
      expect(await git(f.root, 'show', '-s', '--format=%P', landed)).toBe(before)
      expect(await git(f.root, 'rev-list', '--count', `${before}..main`)).toBe('1')
    }
  })

  test('a later observation repairs the post-ref crash window while preserving unrelated dirt', async () => {
    const f = await fixture()
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'crash repair',
      body: '',
    })
    await writeFile(join(f.root, 'shared.txt'), 'operator edit\n')
    let failUpdate = true
    const crashing = new LocalGitForge({
      exec: async (cmd, opts) => {
        if (failUpdate && cmd[0] === 'git' && cmd[1] === 'read-tree' && !cmd.includes('-n')) {
          failUpdate = false
          return { stdout: '', stderr: 'simulated crash boundary', exitCode: 1 }
        }
        return bunExec(cmd, opts)
      },
    })
    await crashing.squashMerge(f.workspace, pr.number, pr.headSha)
    expect(await git(f.root, 'status', '--porcelain')).toContain('shared.txt')

    const state = await new LocalGitForge().getPrState(f.root, pr.number)
    expect(state.state).toBe('merged')
    expect(await Bun.file(join(f.root, 'shared.txt')).text()).toBe('operator edit\n')
    expect(await Bun.file(join(f.root, 'feature.txt')).text()).toBe('feature\n')
  })

  test('post-ref repair waits on a new collision and setAutoMerge reports the recorded transition', async () => {
    const f = await fixture()
    const pr = await f.forge.openPr({
      workspacePath: f.workspace,
      head: f.head,
      base: 'main',
      title: 'blocked crash repair',
      body: '',
    })
    let injectCollision = true
    const racing = new LocalGitForge({
      exec: async (cmd, opts) => {
        if (injectCollision && cmd[0] === 'git' && cmd[1] === 'read-tree' && !cmd.includes('-n')) {
          injectCollision = false
          await writeFile(join(f.root, 'feature.txt'), 'operator collision\n')
        }
        return bunExec(cmd, opts)
      },
    })
    await racing.squashMerge(f.workspace, pr.number, pr.headSha)

    expect(await racing.getPrState(f.root, pr.number)).toEqual({ state: 'open', mergeable: true })
    const deferred = await racing.setAutoMerge(f.root, pr.number, true)
    expect(deferred.kind).toBe('deferred')
    if (deferred.kind !== 'deferred') throw new Error('expected checkout deferral')
    expect(deferred.reason?.detail).toContain('feature.txt')
    expect(await Bun.file(join(f.root, 'feature.txt')).text()).toBe('operator collision\n')

    await rm(join(f.root, 'feature.txt'))
    const landed = await git(f.root, 'rev-parse', 'main')
    expect(await racing.getPrState(f.root, pr.number)).toEqual({ state: 'merged', sha: landed })
    expect(await Bun.file(join(f.root, 'feature.txt')).text()).toBe('feature\n')
  })
})

test('marked summaries replace one private-ref entry across adapters and recreate after deletion', async () => {
  const f = await fixture()
  const pr = await f.forge.openPr({
    workspacePath: f.workspace,
    head: f.head,
    base: 'main',
    title: 'Summary',
    body: '',
  })
  const marker = '<!-- autobuild-summary:v1:6162 -->'
  await f.forge.commentOnPr(f.workspace, pr.number, 'unrelated')
  await f.forge.commentOnPr(f.workspace, pr.number, `${marker}\nold`)
  await new LocalGitForge().commentOnPr(f.workspace, pr.number, `${marker}\nnew`)
  const ref = `refs/autobuild/local-git/prs/${pr.number}`
  const read = async () =>
    JSON.parse(await git(f.root, 'cat-file', 'blob', ref)) as { comments: string[] }
  const record = await read()
  expect(record.comments).toEqual(['unrelated', `${marker}\nnew`])
  record.comments = ['unrelated']
  const hash = Bun.spawn(['git', 'hash-object', '-w', '--stdin'], {
    cwd: f.root,
    stdin: 'pipe',
    stdout: 'pipe',
  })
  hash.stdin.write(JSON.stringify(record))
  hash.stdin.end()
  const sha = (await new Response(hash.stdout).text()).trim()
  expect(await hash.exited).toBe(0)
  await git(f.root, 'update-ref', ref, sha)
  await new LocalGitForge().commentOnPr(f.workspace, pr.number, `${marker}\nrecreated`)
  await new LocalGitForge().commentOnPr(f.workspace, pr.number, `${marker}\nlatest`)
  expect((await read()).comments).toEqual(['unrelated', `${marker}\nlatest`])
})

test('stable merge identity survives rewritten ancestry and finds non-first-parent history', async () => {
  const f = await fixture()
  const original = await git(f.root, 'rev-parse', 'main')
  const body = '# Stable merge\n\nDescription\n\nCo-authored-by: A <a@example.test>\n'
  const pr = await f.forge.openPr({
    workspacePath: f.workspace,
    head: f.head,
    base: 'main',
    title: 'Stable merge',
    body: 'Description',
    mergeMessage: body,
  })
  await f.forge.squashMerge(f.workspace, pr.number, pr.headSha, { buildSlug: 'stable-build' })
  const landed = await git(f.root, 'rev-parse', 'main')
  expect(await git(f.root, 'rev-list', '--count', `${original}..main`)).toBe('1')
  expect(await git(f.root, 'show', '-s', '--format=%P', landed)).toBe(original)
  const message = await f.forge.readCommitMessage(f.root, landed)
  expect(message.trimEnd()).toBe(`${body.trimEnd()}\nAutobuild-Build: stable-build`)
  expect(await git(f.root, 'rev-parse', `${landed}^{tree}`)).toBe(
    await git(f.root, 'rev-parse', `${pr.headSha}^{tree}`),
  )
  await f.forge.squashMerge(f.workspace, pr.number, pr.headSha, { buildSlug: 'stable-build' })
  expect(await git(f.root, 'rev-parse', 'main')).toBe(landed)
  // A forge-side rewrite preserves the message but changes the parent and SHA.
  const tree = await git(f.root, 'rev-parse', `${landed}^{tree}`)
  const parent = await git(f.root, 'commit-tree', tree, '-p', original, '-m', 'Different parent')
  const path = join(f.root, 'landing-message')
  await writeFile(path, message)
  const rewritten = await git(f.root, 'commit-tree', tree, '-p', parent, '-F', path)
  await git(f.root, 'update-ref', 'refs/heads/rewritten', rewritten)
  expect(rewritten).not.toBe(landed)
  expect(
    (await bunExec(['git', 'merge-base', '--is-ancestor', landed, rewritten], { cwd: f.root }))
      .exitCode,
  ).toBe(1)
  expect(await f.forge.containsBuild(f.root, 'rewritten', 'stable-build')).toBe(true)
  expect(await f.forge.containsBuild(f.root, 'rewritten', 'stable')).toBe(false)
  expect(await f.forge.containsBuild(f.root, 'rewritten', 'absent')).toBe(false)
  const merge = await git(
    f.root,
    'commit-tree',
    tree,
    '-p',
    original,
    '-p',
    rewritten,
    '-m',
    'Merge side history',
  )
  await git(f.root, 'update-ref', 'refs/heads/side-history', merge)
  expect(await f.forge.containsBuild(f.root, 'side-history', 'stable-build')).toBe(true)
  await expect(f.forge.containsBuild(f.root, 'missing', 'stable-build')).rejects.toThrow()
  await expect(f.forge.containsBuild(f.root, '--all', 'stable-build')).rejects.toThrow()
})

test('pre-upgrade pending candidate is rebuilt before merge, but merged history is never rewritten', async () => {
  const f = await fixture()
  const pr = await f.forge.openPr({
    workspacePath: f.workspace,
    head: f.head,
    base: 'main',
    title: 'Upgrade',
    body: 'Original',
  })
  // Stop just before CAS, leaving a durable legacy pending candidate.
  const paused = new LocalGitForge({
    exec: async (cmd, opts) => {
      if (cmd[1] === 'update-ref' && cmd[2] === 'refs/heads/main') throw new Error('before CAS')
      return bunExec(cmd, opts)
    },
  })
  await expect(paused.squashMerge(f.workspace, pr.number, pr.headSha)).rejects.toThrow('before CAS')
  const fresh = new LocalGitForge()
  await fresh.squashMerge(f.workspace, pr.number, pr.headSha, { buildSlug: 'upgrade' })
  expect(await fresh.containsBuild(f.root, 'main', 'upgrade')).toBe(true)
  const landed = await git(f.root, 'rev-parse', 'main')
  await fresh.squashMerge(f.workspace, pr.number, pr.headSha, { buildSlug: 'different' })
  expect(await git(f.root, 'rev-parse', 'main')).toBe(landed)
})

test('containsBuild reads reachable messages with one history process regardless of commit count', async () => {
  const f = await fixture()
  const tree = await git(f.root, 'rev-parse', 'main^{tree}')
  let tip = await git(f.root, 'rev-parse', 'main')
  for (let index = 0; index < 25; index++) {
    tip = await git(f.root, 'commit-tree', tree, '-p', tip, '-m', `History ${index}`)
  }
  await git(f.root, 'update-ref', 'refs/heads/history-scan', tip)
  const calls: string[][] = []
  const forge = new LocalGitForge({
    exec: async (cmd, opts) => {
      calls.push(cmd)
      return bunExec(cmd, opts)
    },
  })
  expect(await forge.containsBuild(f.root, 'history-scan', 'absent')).toBe(false)
  expect(calls.map((cmd) => cmd[1])).toEqual(['check-ref-format', 'rev-parse', 'log'])
  expect(calls[2]).toEqual(['git', 'log', '--format=%B%x00', tip, '--'])
})

test('node opening adopts advanced history and reachability distinguishes a moving parent', async () => {
  const f = await fixture()
  const forge = new LocalGitForge({ repoRoot: f.root })
  const opening = await forge.remoteBranchSha('main')
  const node = 'ab-node/integration'
  expect(await forge.createNodeBranch(node, opening)).toBe(opening)
  expect((await forge.compareBranches('main', node)).ahead).toBe(0)
  await writeFile(join(f.root, 'parent-only.txt'), 'parent\n')
  await git(f.root, 'add', '.')
  await git(f.root, 'commit', '-m', 'advance parent')
  expect((await forge.compareBranches('main', node)).ahead).toBe(0)
  const child = await git(f.workspace, 'rev-parse', 'HEAD')
  await git(f.root, 'update-ref', `refs/heads/${node}`, child)
  expect((await forge.compareBranches('main', node)).ahead).toBe(1)
  expect(await forge.createNodeBranch(node, opening)).toBe(child)
  const unrelated = await git(f.root, 'commit-tree', `${child}^{tree}`, '-m', 'unrelated')
  await git(f.root, 'update-ref', 'refs/heads/ab-node/collision', unrelated)
  await expect(forge.createNodeBranch('ab-node/collision', opening)).rejects.toThrow('collision')
})

for (const mode of ['open', 'gated', 'unknown', 'crash-after-push'] as const) {
  test(`controlled node merge uses guarded identity-preserving fast-forward: ${mode}`, async () => {
    const { MemoryBuildStore } = await import('../../store/memory')
    const { sampleBuildInput } = await import('../../store/contract')
    const { readBuildFacts } = await import('../../store/reduced-reads')
    const { DISPATCHER } = await import('../../events/envelope')
    const { landIntoNode } = await import('../../kernel/node-landing')
    const h = await fixture()
    const slug = h.head.slice(3)
    const destination = 'ab-node/target'
    const base = await git(h.workspace, 'rev-parse', 'HEAD^')
    await h.forge.createNodeBranch(destination, base)
    await git(h.workspace, 'commit', '--amend', '-m', `Feature\n\nAutobuild-Build: ${slug}`)
    const candidate = await git(h.workspace, 'rev-parse', 'HEAD')
    const pr = await h.forge.openPr({
      workspacePath: h.workspace,
      head: h.head,
      base: destination,
      title: 'Feature',
      body: 'Feature',
    })
    const store = new MemoryBuildStore()
    await store.createBuild(sampleBuildInput('target'))
    await store.createBuild(sampleBuildInput(slug))
    await store.append('target', { actor: DISPATCHER, type: 'node.opened', payload: { sha: base } })
    await store.append(slug, { actor: DISPATCHER, type: 'pr.opened', payload: { pr } })
    if (mode === 'gated')
      h.forge.inspectLandingGate = async () => ({ kind: 'gated', reason: 'Required checks' })
    if (mode === 'unknown')
      h.forge.inspectLandingGate = async () => ({ kind: 'unproven', reason: 'Policy unavailable' })
    const deps = {
      store,
      forge: h.forge,
      exec: bunExec,
      workspacePath: h.workspace,
      slug,
      node: 'target',
      branch: h.head,
      destination,
      pr: pr.number,
      holder: 'writer',
      id: 'landing',
      eligible: async () => true,
    }
    if (mode === 'crash-after-push') {
      const original = store.appendIfCurrent.bind(store)
      let crash = true
      store.appendIfCurrent = async (...args) => {
        if (args[2].type === 'node.rewritten' && crash) {
          crash = false
          throw new Error('crash after push')
        }
        return original(...args)
      }
      await expect(landIntoNode(deps)).rejects.toThrow('crash after push')
      expect(await git(h.root, 'rev-parse', destination)).toBe(candidate)
    }
    const reason = await landIntoNode(deps)
    if (mode === 'gated' || mode === 'unknown') {
      expect(reason?.code).toBe(mode === 'gated' ? 'gated-node-destination' : 'unproven-gate-state')
      expect(await git(h.root, 'rev-parse', destination)).toBe(base)
      expect(
        (await readBuildFacts(store, 'target')).value.state.nodeRestack?.active,
      ).toBeUndefined()
      expect((await readBuildFacts(store, slug)).value.state.prState).toBe('open')
    } else {
      expect(reason).toBeUndefined()
      expect(await git(h.root, 'rev-parse', destination)).toBe(candidate)
      expect((await readBuildFacts(store, slug)).value.state.mergedSha).toBe(candidate)
      expect(
        (await readBuildFacts(store, 'target')).value.state.nodeRestack?.active,
      ).toBeUndefined()
      expect((await h.forge.getPrState(h.workspace, pr.number)).state).toBe('closed')
    }
  })
}

test('ancestry uses the served repository, distinguishes rewinds, and refuses missing objects', async () => {
  const { root, workspace, forge } = await fixture()
  const base = await git(root, 'rev-parse', 'main')
  const head = await git(workspace, 'rev-parse', 'HEAD')
  expect(await forge.isCommitAncestor(base, head)).toBe(true)
  expect(await forge.isCommitAncestor(head, base)).toBe(false)
  expect(await forge.isCommitAncestor(base, base)).toBe(true)
  await expect(forge.isCommitAncestor('f'.repeat(40), head)).rejects.toThrow(
    'ancestry proof failed',
  )
  await expect(new LocalGitForge().isCommitAncestor(base, head)).rejects.toThrow(
    'requires repoRoot',
  )
})
