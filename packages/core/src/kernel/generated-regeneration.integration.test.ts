import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bunExec } from '../ports/forge/github'
import { regenerateConflict } from './generated-regeneration'

const mkdtemp = ownTempDirectories(afterEach)

/** A cherry-pick of `change` onto `main` that conflicts in gen.txt while
 * src/a.ts applies cleanly and is staged. */
async function conflictedReplay(options: { upstreamDeletes?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-regenerate-'))
  const git = async (args: string[], allowFailure = false) => {
    const result = await bunExec(['git', ...args], { cwd })
    if (result.exitCode !== 0 && !allowFailure) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const write = async (name: string, content: string) => {
    await mkdir(dirname(join(cwd, name)), { recursive: true })
    await writeFile(join(cwd, name), content)
  }
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.invalid'])
  await git(['config', 'commit.gpgsign', 'false'])
  await write('gen.txt', 'base\n')
  await write('src/a.ts', 'a0\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
  await git(['checkout', '-qb', 'change'])
  await write('gen.txt', 'change\n')
  await write('src/a.ts', 'a1\n')
  await git(['add', '-A'])
  await git([
    '-c',
    'user.name=Author',
    '-c',
    'user.email=author@example.invalid',
    'commit',
    '-qm',
    'Change\n\nAutobuild-Build: leaf',
  ])
  const change = await git(['rev-parse', 'HEAD'])
  await git(['checkout', '-q', 'main'])
  if (options.upstreamDeletes) await git(['rm', '-q', 'gen.txt'])
  else {
    await write('gen.txt', 'upstream\n')
    await git(['add', '-A'])
  }
  await git(['commit', '-qm', 'upstream'])
  const target = await git(['rev-parse', 'HEAD'])
  await git(['checkout', '-q', '--detach', target])
  await git(['cherry-pick', change], true)
  expect(await git(['diff', '--name-only', '--diff-filter=U'])).toBe('gen.txt')
  const stagedEdit = await git(['ls-files', '-s', '--', 'src/a.ts'])
  return {
    cwd,
    git,
    write,
    change,
    target,
    stagedEdit,
    run: (command: string) =>
      regenerateConflict(
        { exec: bunExec, workspacePath: cwd },
        {
          files: ['gen.txt'],
          groups: [{ command, files: ['gen.txt'] }],
          selectors: ['gen.txt', 'out/**'],
          identitySource: change,
        },
      ),
  }
}

async function expectRestoredFailure(replay: Awaited<ReturnType<typeof conflictedReplay>>) {
  expect(await replay.git(['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(replay.change)
  expect(await replay.git(['diff', '--name-only', '--diff-filter=U'])).toBe('gen.txt')
  expect(await replay.git(['ls-files', '-s', '--', 'src/a.ts'])).toBe(replay.stagedEdit)
  expect(await readFile(join(replay.cwd, 'src/a.ts'), 'utf8')).toBe('a1\n')
  expect(await replay.git(['ls-files', '--others', '--exclude-standard'])).toBe('scratch.txt')
}

test('resolves a generated conflict and keeps the clean staged edit in the replay', async () => {
  const replay = await conflictedReplay()
  const result = await replay.run(`cat src/a.ts > gen.txt && printf 'regenerated\\n' >> gen.txt`)
  expect(result.outcome).toBe('resolved')
  if (result.outcome !== 'resolved') return
  expect(await replay.git(['rev-parse', 'HEAD'])).toBe(result.head)
  expect(await replay.git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], true)).toBe('')
  expect(await replay.git(['show', '-s', '--format=%P', result.head])).toBe(replay.target)
  expect(await replay.git(['show', `${result.head}:gen.txt`])).toBe('a1\nregenerated')
  expect(await replay.git(['show', `${result.head}:src/a.ts`])).toBe('a1')
  expect(await replay.git(['show', '-s', '--format=%an <%ae>%n%B', result.head])).toBe(
    'Author <author@example.invalid>\nChange\n\nAutobuild-Build: leaf',
  )
  expect(await replay.git(['status', '--porcelain'])).toBe('')
})

test('a failing command returns failed with its output and leaves the recorded conflict', async () => {
  const replay = await conflictedReplay()
  await replay.write('scratch.txt', 'kept\n')
  const result = await replay.run(`echo broken >&2; exit 3`)
  expect(result).toEqual({
    outcome: 'failed',
    reason: '`echo broken >&2; exit 3` exited 3: broken',
  })
  await expectRestoredFailure(replay)
})

test('partial and undeclared output from a failing command is removed, scratch survives', async () => {
  const replay = await conflictedReplay()
  await replay.write('scratch.txt', 'kept\n')
  const result = await replay.run(
    `printf partial > gen.txt; mkdir -p out/deep && printf x > out/deep/new.txt; printf y > junk.txt; exit 1`,
  )
  expect(result.outcome).toBe('failed')
  expect(existsSync(join(replay.cwd, 'junk.txt'))).toBe(false)
  expect(existsSync(join(replay.cwd, 'out'))).toBe(false)
  await expectRestoredFailure(replay)
})

test('a command that writes an undeclared path fails and its output is removed', async () => {
  const replay = await conflictedReplay()
  await replay.write('scratch.txt', 'kept\n')
  const result = await replay.run(`printf regen > gen.txt; printf y > junk.txt`)
  expect(result).toEqual({
    outcome: 'failed',
    reason: 'regeneration changed undeclared path(s): junk.txt',
  })
  expect(existsSync(join(replay.cwd, 'junk.txt'))).toBe(false)
  await expectRestoredFailure(replay)
})

test('a command that rewrites a clean staged hand-written file fails', async () => {
  const replay = await conflictedReplay()
  await replay.write('scratch.txt', 'kept\n')
  const result = await replay.run(`printf regen > gen.txt; printf hacked > src/a.ts`)
  expect(result).toEqual({
    outcome: 'failed',
    reason: 'regeneration changed undeclared path(s): src/a.ts',
  })
  await expectRestoredFailure(replay)
})

test('conflict markers left by the command are never committed', async () => {
  const replay = await conflictedReplay()
  await replay.write('scratch.txt', 'kept\n')
  const result = await replay.run(
    `printf '<<<<<<< HEAD\\nx\\n=======\\ny\\n>>>>>>> change\\n' > gen.txt`,
  )
  expect(result.outcome).toBe('failed')
  if (result.outcome === 'failed')
    expect(result.reason).toStartWith('regenerated files still contain conflict markers')
  expect(await replay.git(['rev-parse', 'HEAD'])).toBe(replay.target)
  expect(await replay.git(['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(replay.change)
})

test('a modify/delete conflict starts from the base side and commits the regenerated file', async () => {
  const replay = await conflictedReplay({ upstreamDeletes: true })
  const before = await replay.git(['ls-files', '-s', '--', 'gen.txt'])
  expect(before).not.toContain(' 2\t')
  const result = await replay.run(`printf 'rebuilt\\n' > gen.txt`)
  expect(result.outcome).toBe('resolved')
  if (result.outcome !== 'resolved') return
  expect(await replay.git(['show', `${result.head}:gen.txt`])).toBe('rebuilt')
  expect(await replay.git(['show', `${result.head}:src/a.ts`])).toBe('a1')
})

test('a conflict that does not reproduce fails without running anything', async () => {
  const replay = await conflictedReplay()
  const result = await regenerateConflict(
    { exec: bunExec, workspacePath: replay.cwd },
    {
      files: ['other.txt'],
      groups: [{ command: 'printf ran > ran.txt', files: ['other.txt'] }],
      selectors: ['other.txt'],
      identitySource: replay.change,
    },
  )
  expect(result).toEqual({
    outcome: 'failed',
    reason: 'conflict did not reproduce: expected other.txt, found gen.txt',
  })
  expect(existsSync(join(replay.cwd, 'ran.txt'))).toBe(false)
})
