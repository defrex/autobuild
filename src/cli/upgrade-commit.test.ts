import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnExec } from '../ports/workspace/git-worktree'
import type { UpgradeReport } from './upgrade'
import {
  addUpgradeSelfUpdatePaths,
  cleanupUpgradeCommitContext,
  createUpgradeCommitContext,
  finishUpgradeCommit,
} from './upgrade-commit'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const result = await spawnExec(['git', ...args], { cwd: repo })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout
}

async function repository(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'ab-upgrade-commit-test-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'user.name', 'Upgrade Test')
  await git(repo, 'config', 'user.email', 'upgrade@example.test')
  await writeFile(join(repo, 'README.md'), 'base\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-qm', 'base')
  return repo
}

function report(
  skills: UpgradeReport['skills'],
  discoveryConflicts: UpgradeReport['discoveryConflicts'] = [],
): UpgradeReport {
  return { skills, discoveryConflicts, exitCode: discoveryConflicts.length > 0 ? 1 : 0 }
}

describe('upgrade commit coordinator', () => {
  test('commits additions, modifications, deletions, links, and local self-update files together', async () => {
    const repo = await repository()
    const plan = join(repo, '.agents', 'skills', 'ab-plan', 'SKILL.md')
    const guide = join(repo, '.agents', 'skills', 'ab-guide', 'old.md')
    const pristine = join(repo, '.agents', 'skills', '.ab-pristine', 'ab-plan', 'SKILL.md')
    const link = join(repo, '.claude', 'skills', 'ab-plan')
    await mkdir(dirname(plan), { recursive: true })
    await mkdir(dirname(guide), { recursive: true })
    await mkdir(dirname(pristine), { recursive: true })
    await mkdir(dirname(link), { recursive: true })
    await writeFile(plan, 'old plan\n')
    await writeFile(guide, 'retire me\n')
    await writeFile(pristine, 'old pristine\n')
    await writeFile(join(repo, 'package.json'), '{}\n')
    await writeFile(join(repo, 'bun.lock'), '{}\n')
    await symlink('../../../.agents/skills/ab-plan', link)
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'installed')

    const context = await createUpgradeCommitContext(repo)
    await writeFile(plan, 'new plan\n')
    await writeFile(pristine, 'new pristine\n')
    await rm(guide)
    await rm(link)
    const special = join(repo, '.agents', 'skills', 'ab-plan', 'space [new].md')
    await writeFile(special, 'new support\n')
    await writeFile(join(repo, 'package.json'), '{"dependencies":{"autobuild":"new"}}\n')
    await writeFile(join(repo, 'bun.lock'), '{"lock":"new"}\n')
    await addUpgradeSelfUpdatePaths(context.path, [
      join(repo, 'package.json'),
      join(repo, 'bun.lock'),
      join(root!, 'outside-global-state'),
    ])

    const out: string[] = []
    const errors: string[] = []
    await finishUpgradeCommit(
      context,
      report([
        { skill: 'ab-plan', action: 'merged' },
        { skill: 'ab-guide', action: 'removed' },
      ]),
      { stdout: (line) => out.push(line), stderr: (line) => errors.push(line) },
    )

    expect(errors).toEqual([])
    expect(out).toEqual(['ab upgrade: committed upgrade-owned changes'])
    expect(await git(repo, 'status', '--porcelain')).toBe('')
    const names = await git(repo, 'show', '--format=', '--name-status', 'HEAD')
    expect(names).toContain('M\t.agents/skills/ab-plan/SKILL.md')
    expect(names).toContain('A\t.agents/skills/ab-plan/space [new].md')
    expect(names).toContain('D\t.agents/skills/ab-guide/old.md')
    expect(names).toContain('D\t.claude/skills/ab-plan')
    expect(names).toContain('M\tpackage.json')
    expect(names).toContain('M\tbun.lock')
    const message = await git(repo, 'log', '-1', '--format=%B')
    expect(message).toContain('ab upgrade:')
    expect(message).toContain('- ab-plan: merged')
    expect(message).toContain('- ab-guide: removed')
    expect(message).not.toContain('Co-authored-by')
    await cleanupUpgradeCommitContext(context)
  })

  test('does not create a commit for a no-op', async () => {
    const repo = await repository()
    const before = (await git(repo, 'rev-parse', 'HEAD')).trim()
    const context = await createUpgradeCommitContext(repo)
    await finishUpgradeCommit(context, report([{ skill: 'ab-plan', action: 'current' }]))
    expect((await git(repo, 'rev-parse', 'HEAD')).trim()).toBe(before)
    await cleanupUpgradeCommitContext(context)
  })

  test('preserves unrelated staged, unstaged, and untracked work', async () => {
    const repo = await repository()
    for (const [path, content] of [
      ['staged.txt', 'old staged\n'],
      ['unstaged.txt', 'old unstaged\n'],
    ] as const) {
      await writeFile(join(repo, path), content)
    }
    const skill = join(repo, '.agents', 'skills', 'ab-plan', 'SKILL.md')
    await mkdir(dirname(skill), { recursive: true })
    await writeFile(skill, 'old\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'fixture')

    const context = await createUpgradeCommitContext(repo)
    await writeFile(join(repo, 'staged.txt'), 'new staged\n')
    await git(repo, 'add', 'staged.txt')
    await writeFile(join(repo, 'unstaged.txt'), 'new unstaged\n')
    await writeFile(join(repo, 'untracked.txt'), 'operator work\n')
    await writeFile(skill, 'upgraded\n')

    await finishUpgradeCommit(context, report([{ skill: 'ab-plan', action: 'adopted' }]))

    expect(await git(repo, 'show', '--format=', '--name-only', 'HEAD')).toBe(
      '.agents/skills/ab-plan/SKILL.md\n',
    )
    const status = await git(repo, 'status', '--porcelain')
    expect(status).toContain('M  staged.txt')
    expect(status).toContain(' M unstaged.txt')
    expect(status).toContain('?? untracked.txt')
    expect(await git(repo, 'diff', '--cached', '--', 'staged.txt')).toContain('new staged')
    await cleanupUpgradeCommitContext(context)
  })

  test('pre-existing dirt in a managed path suppresses the whole commit', async () => {
    const repo = await repository()
    const skill = join(repo, '.agents', 'skills', 'ab-plan', 'SKILL.md')
    await mkdir(dirname(skill), { recursive: true })
    await writeFile(skill, 'old\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'fixture')
    await writeFile(skill, 'operator edit\n')
    const context = await createUpgradeCommitContext(repo)
    await writeFile(skill, 'upgrade result\n')
    const before = (await git(repo, 'rev-parse', 'HEAD')).trim()
    const errors: string[] = []

    await finishUpgradeCommit(context, report([{ skill: 'ab-plan', action: 'merged' }]), {
      stderr: (line) => errors.push(line),
    })

    expect((await git(repo, 'rev-parse', 'HEAD')).trim()).toBe(before)
    expect(errors.join('\n')).toContain('already modified before the run')
    expect(errors.join('\n')).toContain('.agents/skills/ab-plan/SKILL.md')
    expect(await readFile(skill, 'utf8')).toBe('upgrade result\n')
    await cleanupUpgradeCommitContext(context)
  })

  test('content and discovery conflicts suppress without changing their report status', async () => {
    const repo = await repository()
    const context = await createUpgradeCommitContext(repo)
    const skill = join(repo, '.agents', 'skills', 'ab-plan', 'SKILL.md')
    await mkdir(dirname(skill), { recursive: true })
    await writeFile(skill, 'other successful merge\n')
    const errors: string[] = []
    const upgradeReport = report(
      [
        { skill: 'ab-plan', action: 'adopted' },
        { skill: 'ab-guide', action: 'conflicted' },
      ],
      [{ skill: 'ab-review', message: 'distinct directory' }],
    )

    await finishUpgradeCommit(context, upgradeReport, { stderr: (line) => errors.push(line) })

    expect(upgradeReport.exitCode).toBe(1)
    expect(errors.join('\n')).toContain('content conflicts remain for ab-guide')
    expect(errors.join('\n')).toContain('Claude discovery conflicts remain for ab-review')
    expect(await git(repo, 'status', '--porcelain')).toContain('?? .agents/')
    await cleanupUpgradeCommitContext(context)
  })

  test('non-Git and in-progress repositories name the safety blocker', async () => {
    root = await mkdtemp(join(tmpdir(), 'ab-upgrade-commit-unsafe-'))
    const plain = join(root, 'plain')
    await mkdir(plain)
    const plainContext = await createUpgradeCommitContext(plain)
    const plainErrors: string[] = []
    await finishUpgradeCommit(plainContext, report([]), {
      stderr: (line) => plainErrors.push(line),
    })
    expect(plainErrors.join('\n')).toContain('not a Git repository')
    await cleanupUpgradeCommitContext(plainContext)

    const repo = join(root, 'repo')
    await mkdir(repo)
    await git(repo, 'init', '-q')
    await git(repo, 'config', 'user.name', 'Upgrade Test')
    await git(repo, 'config', 'user.email', 'upgrade@example.test')
    await writeFile(join(repo, 'base'), 'base\n')
    await git(repo, 'add', 'base')
    await git(repo, 'commit', '-qm', 'base')
    const gitDir = (await git(repo, 'rev-parse', '--absolute-git-dir')).trim()
    await writeFile(
      join(gitDir, 'CHERRY_PICK_HEAD'),
      `${(await git(repo, 'rev-parse', 'HEAD')).trim()}\n`,
    )
    const operationContext = await createUpgradeCommitContext(repo)
    const operationErrors: string[] = []
    await finishUpgradeCommit(operationContext, report([]), {
      stderr: (line) => operationErrors.push(line),
    })
    expect(operationErrors.join('\n')).toContain('mid-cherry-pick')
    await cleanupUpgradeCommitContext(operationContext)
  })

  test('a rejecting commit hook restores the exact linked-worktree index and keeps output', async () => {
    const primary = await repository()
    const repo = join(root!, 'linked')
    await git(primary, 'worktree', 'add', '-qb', 'upgrade-test', repo)
    const operator = join(repo, 'operator.txt')
    const skill = join(repo, '.agents', 'skills', 'ab-plan', 'SKILL.md')
    const support = join(repo, '.agents', 'skills', 'ab-plan', 'new-support.md')
    await mkdir(dirname(skill), { recursive: true })
    await writeFile(operator, 'operator base\n')
    await writeFile(skill, 'old skill\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'fixture')

    await writeFile(operator, 'operator staged\n')
    await git(repo, 'add', 'operator.txt')
    await writeFile(operator, 'operator worktree\n')
    const context = await createUpgradeCommitContext(repo)
    await writeFile(skill, 'upgraded skill\n')
    await writeFile(support, 'new upgrade support\n')

    const gitDir = (await git(repo, 'rev-parse', '--absolute-git-dir')).trim()
    const primaryGitDir = (await git(primary, 'rev-parse', '--absolute-git-dir')).trim()
    const hook = join(primaryGitDir, 'hooks', 'pre-commit')
    await writeFile(hook, '#!/bin/sh\necho "hook rejected commit" >&2\nexit 1\n', {
      mode: 0o755,
    })
    const cachedBefore = await git(repo, 'diff', '--cached', '--binary')
    const indexBefore = await readFile(join(gitDir, 'index'))
    const primaryIndexBefore = await readFile(join(primaryGitDir, 'index'))
    const headBefore = (await git(repo, 'rev-parse', 'HEAD')).trim()
    const errors: string[] = []
    const upgradeReport = report([{ skill: 'ab-plan', action: 'merged' }])

    await finishUpgradeCommit(context, upgradeReport, {
      stderr: (line) => errors.push(line),
    })

    expect(Buffer.compare(await readFile(join(gitDir, 'index')), indexBefore)).toBe(0)
    expect(Buffer.compare(await readFile(join(primaryGitDir, 'index')), primaryIndexBefore)).toBe(0)
    expect((await git(repo, 'rev-parse', 'HEAD')).trim()).toBe(headBefore)
    expect(upgradeReport.exitCode).toBe(0)
    expect(errors.join('\n')).toContain('ab upgrade could not commit its changes')
    expect(errors.join('\n')).toContain('committing upgrade-owned paths failed (exit 1)')
    expect(errors.join('\n')).toContain('hook rejected commit')
    expect(await git(repo, 'diff', '--cached', '--binary')).toBe(cachedBefore)
    expect(await git(repo, 'status', '--porcelain')).toBe(
      ' M .agents/skills/ab-plan/SKILL.md\n' +
        'MM operator.txt\n' +
        '?? .agents/skills/ab-plan/new-support.md\n',
    )
    expect(await readFile(operator, 'utf8')).toBe('operator worktree\n')
    expect(await readFile(skill, 'utf8')).toBe('upgraded skill\n')
    expect(await readFile(support, 'utf8')).toBe('new upgrade support\n')
    await cleanupUpgradeCommitContext(context)
  })
})
