import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  normalizeClaudeSummary,
  parseReleaseArguments,
  README_INSTALL_END,
  README_INSTALL_START,
  renderReleasedChangelog,
  replacePackageVersion,
  replaceReadmeInstall,
  resolveReleaseVersion,
  runRelease,
  spawnCommand,
  type CommandRequest,
  type CommandResult,
  type ReleaseOutput,
} from './release'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

async function command(
  cwd: string,
  commandName: string,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await spawnCommand({ command: commandName, args, cwd })
  if (result.exitCode !== 0) {
    throw new Error(`${commandName} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result
}

interface Fixture {
  root: string
  remote: string
}

const fixtureConfig = `baseBranch = "main"

[commands]
lint = "true"
typecheck = "true"
test = "true"
`

const fixtureChangelog = `# Changelog

## Unreleased

- [#2](https://example.test/2) — New capability
- [#1](https://example.test/1) — Important repair
`

const fixtureReadme = `# Fixture

${README_INSTALL_START}

\`\`\`sh
bun add github:defrex/autobuild#main
\`\`\`

${README_INSTALL_END}
`

async function createFixture(
  overrides: { config?: string; changelog?: string } = {},
): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'autobuild-release-'))
  temporaryDirectories.push(parent)
  const root = join(parent, 'repo')
  const remote = join(parent, 'origin.git')
  await command(parent, 'git', ['init', '--bare', remote])
  await command(parent, 'git', ['init', '-b', 'main', root])
  await command(root, 'git', ['config', 'user.name', 'Release Test'])
  await command(root, 'git', ['config', 'user.email', 'release@example.test'])
  await Promise.all([
    writeFile(join(root, 'autobuild.toml'), overrides.config ?? fixtureConfig),
    writeFile(join(root, 'package.json'), '{\n  "name": "fixture",\n  "version": "2.0.0"\n}\n'),
    writeFile(join(root, 'CHANGELOG.md'), overrides.changelog ?? fixtureChangelog),
    writeFile(join(root, 'README.md'), fixtureReadme),
  ])
  await command(root, 'git', ['add', '.'])
  await command(root, 'git', ['commit', '-m', 'initial'])
  await command(root, 'git', ['remote', 'add', 'origin', remote])
  await command(root, 'git', ['push', '-u', 'origin', 'main'])
  return { root, remote }
}

interface Harness {
  requests: CommandRequest[]
  logs: string[]
  warnings: string[]
  run(request: CommandRequest): Promise<CommandResult>
  output: ReleaseOutput
}

function harness(
  claude: CommandResult = {
    exitCode: 0,
    stdout: 'This release adds a new capability and delivers an important repair.\n',
    stderr: '',
  },
): Harness {
  const requests: CommandRequest[] = []
  const logs: string[] = []
  const warnings: string[] = []
  return {
    requests,
    logs,
    warnings,
    run: async (request) => {
      requests.push(request)
      if (request.command === 'claude') return claude
      if (request.command === 'gh') return { exitCode: 0, stdout: '', stderr: '' }
      return spawnCommand(request)
    },
    output: {
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    },
  }
}

function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function expectReleaseFailure(
  root: string,
  expected: RegExp,
  testHarness = harness(),
): Promise<void> {
  const beforeHead = (await command(root, 'git', ['rev-parse', 'HEAD'])).stdout
  const beforeStatus = (await command(root, 'git', ['status', '--porcelain'])).stdout
  let error: unknown
  try {
    await runRelease(['--patch'], root, {
      run: testHarness.run,
      output: testHarness.output,
      today: () => '2026-07-27',
    })
  } catch (caught) {
    error = caught
  }
  expect(thrownMessage(error)).toMatch(expected)
  expect((await command(root, 'git', ['rev-parse', 'HEAD'])).stdout).toBe(beforeHead)
  expect((await command(root, 'git', ['status', '--porcelain'])).stdout).toBe(beforeStatus)
}

describe('release transforms', () => {
  test('requires exactly one version selector', () => {
    expect(() => parseReleaseArguments([])).toThrow('choose exactly one')
    expect(() => parseReleaseArguments(['--patch', '--minor'])).toThrow('choose only one')
    expect(() => parseReleaseArguments(['--version', '2.1.0', '--patch'])).toThrow(
      'choose exactly one',
    )
    expect(parseReleaseArguments(['--dry-run', '--version', '2.1.0'])).toEqual({
      dryRun: true,
      version: '2.1.0',
    })
  })

  test('resolves explicit and major/minor/patch versions', () => {
    expect(resolveReleaseVersion('2.3.4', { dryRun: false, version: '3.0.0' })).toBe('3.0.0')
    expect(resolveReleaseVersion('2.3.4', { dryRun: false, bump: 'major' })).toBe('3.0.0')
    expect(resolveReleaseVersion('2.3.4', { dryRun: false, bump: 'minor' })).toBe('2.4.0')
    expect(resolveReleaseVersion('2.3.4', { dryRun: false, bump: 'patch' })).toBe('2.3.5')
    expect(() => resolveReleaseVersion('nope', { dryRun: false, bump: 'patch' })).toThrow(
      'not valid semver',
    )
    expect(() => resolveReleaseVersion('2.0.0', { dryRun: false, version: 'v2.1.0' })).toThrow(
      'exact semver',
    )
  })

  test('normalizes only usable plain-prose Claude output', () => {
    expect(normalizeClaudeSummary('  A useful release ships.\nIt also fixes reliability.  ')).toBe(
      'A useful release ships. It also fixes reliability.',
    )
    expect(normalizeClaudeSummary('')).toBeUndefined()
    expect(normalizeClaudeSummary('- A bullet, not prose.')).toBeUndefined()
    expect(normalizeClaudeSummary('too short')).toBeUndefined()
  })

  test('cuts one release while preserving entry and released-section bytes', () => {
    const oldRelease = '## v1.9.0 — 2026-01-01\n\nOld prose.\n\n- old entry\n'
    const source = `${fixtureChangelog}\n${oldRelease}`
    const rendered = renderReleasedChangelog(source, 'v2.0.1', '2026-07-27', 'Release prose.')
    expect(rendered.entries).toBe(
      '- [#2](https://example.test/2) — New capability\n- [#1](https://example.test/1) — Important repair',
    )
    expect(rendered.content.match(/^## Unreleased$/gm)).toHaveLength(1)
    expect(rendered.content).toContain('## Unreleased\n\n## v2.0.1 — 2026-07-27')
    expect(rendered.content).toContain(rendered.entries)
    expect(rendered.content).toContain(`${rendered.entries}\n\n${oldRelease}`)
    expect(rendered.content.endsWith(oldRelease)).toBe(true)
    expect(rendered.cutSection).toBe(
      `## v2.0.1 — 2026-07-27\n\nRelease prose.\n\n${rendered.entries}\n`,
    )
    expect(() =>
      renderReleasedChangelog('# Changelog\n\n## Unreleased\n\n', 'v2.0.1', '2026-07-27'),
    ).toThrow('has no entries')
  })

  test('strictly replaces only the fenced README command and manifest version', () => {
    const replaced = replaceReadmeInstall(fixtureReadme, 'v2.1.0')
    expect(replaced).toContain('bun add github:defrex/autobuild#v2.1.0')
    expect(replaced.match(/release-install:start/g)).toHaveLength(1)
    expect(() => replaceReadmeInstall('# no markers\n', 'v2.1.0')).toThrow('exactly one')
    expect(() =>
      replaceReadmeInstall(`${README_INSTALL_END}\n${README_INSTALL_START}`, 'v2.1.0'),
    ).toThrow('out of order')
    expect(replacePackageVersion('{\n  "version": "2.0.0"\n}\n', '2.1.0')).toBe(
      '{\n  "version": "2.1.0"\n}\n',
    )
  })
})

describe('release orchestration', () => {
  test('commits three files, pushes an annotated tag, and publishes the exact cut section', async () => {
    const fixture = await createFixture()
    const testHarness = harness()
    const before = (await command(fixture.root, 'git', ['rev-parse', 'HEAD'])).stdout.trim()

    await runRelease(['--patch'], fixture.root, {
      run: testHarness.run,
      output: testHarness.output,
      today: () => '2026-07-27',
    })

    const head = (await command(fixture.root, 'git', ['rev-parse', 'HEAD'])).stdout.trim()
    expect(head).not.toBe(before)
    expect((await command(fixture.root, 'git', ['rev-parse', 'HEAD^'])).stdout.trim()).toBe(before)
    expect(
      (
        await command(fixture.root, 'git', [
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '-r',
          'HEAD',
        ])
      ).stdout
        .trim()
        .split('\n')
        .sort(),
    ).toEqual(['CHANGELOG.md', 'README.md', 'package.json'])
    expect((await command(fixture.root, 'git', ['cat-file', '-t', 'v2.0.1'])).stdout.trim()).toBe(
      'tag',
    )
    expect((await command(fixture.root, 'git', ['rev-parse', 'v2.0.1^{}'])).stdout.trim()).toBe(
      head,
    )
    expect(
      (await command(fixture.root, 'git', ['ls-remote', 'origin', 'refs/heads/main'])).stdout,
    ).toStartWith(head)
    expect(
      (await command(fixture.root, 'git', ['ls-remote', 'origin', 'refs/tags/v2.0.1^{}'])).stdout,
    ).toStartWith(head)

    const gh = testHarness.requests.find((request) => request.command === 'gh')
    expect(gh?.args).toEqual([
      'release',
      'create',
      'v2.0.1',
      '--verify-tag',
      '--title',
      'v2.0.1',
      '--notes-file',
      '-',
    ])
    expect(gh?.stdin).toBe(
      '## v2.0.1 — 2026-07-27\n\nThis release adds a new capability and delivers an important repair.\n\n' +
        '- [#2](https://example.test/2) — New capability\n' +
        '- [#1](https://example.test/1) — Important repair\n',
    )
    expect(await readFile(join(fixture.root, 'package.json'), 'utf8')).toContain(
      '"version": "2.0.1"',
    )
    expect(await readFile(join(fixture.root, 'README.md'), 'utf8')).toContain('#v2.0.1')
    expect((await command(fixture.root, 'git', ['status', '--porcelain'])).stdout).toBe('')
  })

  test('dry-run runs gates and Claude but leaves files, HEAD, refs, remote, and release calls unchanged', async () => {
    const fixture = await createFixture()
    const testHarness = harness()
    const files = await Promise.all(
      ['CHANGELOG.md', 'README.md', 'package.json'].map((path) =>
        readFile(join(fixture.root, path), 'utf8'),
      ),
    )
    const head = (await command(fixture.root, 'git', ['rev-parse', 'HEAD'])).stdout
    const refs = (await command(fixture.root, 'git', ['show-ref'])).stdout
    const remoteRefs = (await command(fixture.root, 'git', ['ls-remote', 'origin'])).stdout

    await runRelease(['--minor', '--dry-run'], fixture.root, {
      run: testHarness.run,
      output: testHarness.output,
      today: () => '2026-07-27',
    })

    expect(
      await Promise.all(
        ['CHANGELOG.md', 'README.md', 'package.json'].map((path) =>
          readFile(join(fixture.root, path), 'utf8'),
        ),
      ),
    ).toEqual(files)
    expect((await command(fixture.root, 'git', ['rev-parse', 'HEAD'])).stdout).toBe(head)
    expect((await command(fixture.root, 'git', ['show-ref'])).stdout).toBe(refs)
    expect((await command(fixture.root, 'git', ['ls-remote', 'origin'])).stdout).toBe(remoteRefs)
    expect(testHarness.requests.some((request) => request.command === 'claude')).toBe(true)
    expect(testHarness.requests.some((request) => request.command === 'gh')).toBe(false)
    expect(testHarness.logs.join('\n')).toContain('This release adds a new capability')
    expect(testHarness.logs.join('\n')).toContain('bun add github:defrex/autobuild#v2.1.0')
  })

  test('names dirty, wrong-branch, empty-section, local-tag, and remote-tag refusals', async () => {
    const dirty = await createFixture()
    await writeFile(join(dirty.root, 'README.md'), `${fixtureReadme}\ndirty\n`)
    await expectReleaseFailure(dirty.root, /worktree is dirty/)

    const wrongBranch = await createFixture()
    await command(wrongBranch.root, 'git', ['switch', '-c', 'other'])
    await expectReleaseFailure(wrongBranch.root, /release from configured base branch "main"/)

    const empty = await createFixture({ changelog: '# Changelog\n\n## Unreleased\n\n' })
    await expectReleaseFailure(empty.root, /Unreleased section has no entries/)

    const localTag = await createFixture()
    await command(localTag.root, 'git', ['tag', '-a', 'v2.0.1', '-m', 'existing'])
    await expectReleaseFailure(localTag.root, /target tag v2\.0\.1 already exists locally/)

    const remoteTag = await createFixture()
    await command(remoteTag.root, 'git', ['tag', '-a', 'v2.0.1', '-m', 'existing'])
    await command(remoteTag.root, 'git', ['push', 'origin', 'v2.0.1'])
    await command(remoteTag.root, 'git', ['tag', '--delete', 'v2.0.1'])
    await expectReleaseFailure(
      remoteTag.root,
      /target tag v2\.0\.1 already exists on remote origin/,
    )
  }, 20_000)

  test('refuses a local base branch behind its fetched remote', async () => {
    const fixture = await createFixture()
    const clone = join(fixture.root, '..', 'other-clone')
    await command(join(fixture.root, '..'), 'git', [
      'clone',
      '--branch',
      'main',
      fixture.remote,
      clone,
    ])
    await command(clone, 'git', ['config', 'user.name', 'Remote Test'])
    await command(clone, 'git', ['config', 'user.email', 'remote@example.test'])
    await writeFile(join(clone, 'remote.txt'), 'remote\n')
    await command(clone, 'git', ['add', 'remote.txt'])
    await command(clone, 'git', ['commit', '-m', 'remote advance'])
    await command(clone, 'git', ['push', 'origin', 'main'])

    await expectReleaseFailure(fixture.root, /behind origin\/main by 1 commit/)
  })

  test('a failing quality gate leaves the tracked tree unchanged', async () => {
    const config = fixtureConfig.replace('typecheck = "true"', 'typecheck = "false"')
    const fixture = await createFixture({ config })
    await expectReleaseFailure(
      fixture.root,
      /typecheck quality gate failed.*no release files were changed/,
    )
  })

  test('missing, erroring, or blank Claude output warns and preserves bullets', async () => {
    for (const claudeResult of [
      { exitCode: 127, stdout: '', stderr: 'claude: not found' },
      { exitCode: 1, stdout: '', stderr: 'provider error' },
      { exitCode: 0, stdout: '   \n', stderr: '' },
    ]) {
      const fixture = await createFixture()
      const testHarness = harness(claudeResult)
      await runRelease(['--patch'], fixture.root, {
        run: testHarness.run,
        output: testHarness.output,
        today: () => '2026-07-27',
      })
      const changelog = await readFile(join(fixture.root, 'CHANGELOG.md'), 'utf8')
      expect(changelog).toContain('- [#2](https://example.test/2) — New capability')
      expect(changelog).toContain('- [#1](https://example.test/1) — Important repair')
      expect(testHarness.warnings.join('\n')).toContain('release summary omitted')
    }
  })

  test('the finalize skill explicitly inserts before the next release heading', async () => {
    const skill = await readFile(
      join(import.meta.dir, '..', '.agents/skills/ab-finalize-changelog/SKILL.md'),
      'utf8',
    )
    expect(skill).toContain('bounded by that\n  heading and the next level-two heading')
    expect(skill).toContain(
      'before that release heading — never beneath or inside the released section',
    )
  })
})
