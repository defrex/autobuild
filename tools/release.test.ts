import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { repoRoot } from './git-tracked'
import { readWorkspaceManifests } from './workspace-manifest-check'
import type { WorkspaceManifest } from './workspace-manifest-check'
import {
  normalizeClaudeSummary,
  parseReleaseArguments,
  peerFloorRefusalMessage,
  peerFloorViolations,
  README_INSTALL_END,
  README_INSTALL_START,
  renderReleasedChangelog,
  replacePackageVersion,
  replaceReadmeInstall,
  resolveReleaseVersion,
  runRelease,
  spawnCommand,
  uploadDistributionAsset,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type PeerFloorViolation,
  type ReleaseOutput,
  publishablePackages,
  publishRecoveryCommand,
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
bun add -g @defrex/autobuild@0.0.0
\`\`\`

${README_INSTALL_END}
`

async function createFixture(
  overrides: {
    config?: string
    changelog?: string
    /** Extra workspace manifests to write and commit, as repo-relative
     * manifest paths; the shared fixture stays peer-free. */
    extraPackages?: { path: string; text: string }[]
  } = {},
): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'autobuild-release-'))
  temporaryDirectories.push(parent)
  const root = join(parent, 'repo')
  const remote = join(parent, 'origin.git')
  await command(parent, 'git', ['init', '--bare', remote])
  await command(parent, 'git', ['init', '-b', 'main', root])
  await command(root, 'git', ['config', 'user.name', 'Release Test'])
  await command(root, 'git', ['config', 'user.email', 'release@example.test'])
  await mkdir(join(root, 'packages', 'core'), { recursive: true })
  await Promise.all([
    writeFile(join(root, 'autobuild.toml'), overrides.config ?? fixtureConfig),
    writeFile(
      join(root, 'package.json'),
      '{\n  "name": "fixture",\n  "version": "2.0.0",\n  "workspaces": ["packages/*"]\n}\n',
    ),
    writeFile(
      join(root, 'packages', 'core', 'package.json'),
      '{\n  "name": "@fixture/core",\n  "version": "2.0.0"\n}\n',
    ),
    writeFile(join(root, 'CHANGELOG.md'), overrides.changelog ?? fixtureChangelog),
    writeFile(join(root, 'README.md'), fixtureReadme),
    ...(overrides.extraPackages ?? []).map((extra) =>
      mkdir(join(root, dirname(extra.path)), { recursive: true }).then(() =>
        writeFile(join(root, extra.path), extra.text),
      ),
    ),
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
  github: CommandResult = { exitCode: 0, stdout: '', stderr: '' },
  registry: { whoami: CommandResult; publish: CommandResult } = {
    whoami: { exitCode: 0, stdout: 'release-bot\n', stderr: '' },
    publish: { exitCode: 0, stdout: '', stderr: '' },
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
      if (request.command === 'gh') {
        // The distribution-asset verification reads the release's assets.
        if (request.args[0] === 'release' && request.args[1] === 'view') {
          const tag = request.args[2] ?? ''
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              assets: [{ name: `autobuild-${tag.slice(1)}.tgz`, size: 1234 }],
            }),
            stderr: '',
          }
        }
        return github
      }
      if (request.command === 'bun' && request.args[0] === 'install') {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (request.command === 'bun' && request.args[0] === 'pm' && request.args[1] === 'whoami') {
        return registry.whoami
      }
      if (request.command === 'bun' && request.args[0] === 'publish') {
        return registry.publish
      }
      if (request.command === 'bun' && request.args.join(' ') === 'run --silent postgres:migrate') {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'AB_POSTGRES_URL or DATABASE_URL is required and must be nonblank\n',
        }
      }
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
  args: readonly string[] = ['--patch'],
): Promise<void> {
  const beforeHead = (await command(root, 'git', ['rev-parse', 'HEAD'])).stdout
  const beforeStatus = (await command(root, 'git', ['status', '--porcelain'])).stdout
  let error: unknown
  try {
    await runRelease(args, root, {
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
    const replaced = replaceReadmeInstall(fixtureReadme, '2.1.0')
    expect(replaced).toContain('bun add -g @defrex/autobuild@2.1.0')
    expect(replaced).not.toContain('github:')
    expect(replaced.match(/release-install:start/g)).toHaveLength(1)
    expect(() => replaceReadmeInstall('# no markers\n', '2.1.0')).toThrow('exactly one')
    expect(() =>
      replaceReadmeInstall(`${README_INSTALL_END}\n${README_INSTALL_START}`, '2.1.0'),
    ).toThrow('out of order')
    expect(replacePackageVersion('{\n  "version": "2.0.0"\n}\n', '2.1.0')).toBe(
      '{\n  "version": "2.1.0"\n}\n',
    )
  })
})

describe('peer floor guard', () => {
  function manifestEntry(path: string, manifest: Record<string, unknown>): WorkspaceManifest {
    return {
      path,
      text: JSON.stringify(manifest),
      manifest: manifest as WorkspaceManifest['manifest'],
    }
  }

  function dependentManifest(range: string): string {
    return `{\n  "name": "@fixture/dep",\n  "version": "2.0.0",\n  "peerDependencies": {\n    "fixture": "${range}"\n  }\n}\n`
  }

  test('flags a requested version below a declared peer floor, and passes compliant versions', () => {
    const manifests = [
      manifestEntry('package.json', { name: 'fixture', version: '0.8.0' }),
      manifestEntry('packages/service/package.json', {
        name: '@fixture/service',
        version: '0.8.0',
        peerDependencies: { fixture: '>=0.9.0' },
        peerDependenciesMeta: { fixture: { optional: true } },
      }),
    ]
    expect(peerFloorViolations(manifests, ['fixture'], '0.8.1')).toEqual([
      { manifestPath: 'packages/service/package.json', peerName: 'fixture', range: '>=0.9.0' },
    ] satisfies PeerFloorViolation[])
    expect(peerFloorViolations(manifests, ['fixture'], '0.9.0')).toEqual([])
    expect(peerFloorViolations(manifests, ['fixture'], '1.0.0')).toEqual([])
  })

  test('ignores peers on names this release does not publish and private dependents', () => {
    const manifests = [
      manifestEntry('package.json', { name: 'fixture', version: '0.8.0' }),
      manifestEntry('packages/service/package.json', {
        name: '@fixture/service',
        version: '0.8.0',
        peerDependencies: { 'unrelated-package': '>=99.0.0' },
      }),
      manifestEntry('packages/private/package.json', {
        name: '@fixture/private',
        version: '0.8.0',
        private: true,
        peerDependencies: { fixture: '<0.8.0' },
      }),
    ]
    expect(peerFloorViolations(manifests, ['fixture'], '0.8.1')).toEqual([])
  })

  test('satisfies workspace-protocol peers by construction and checks remainders', () => {
    const manifests = [
      manifestEntry('package.json', { name: 'fixture', version: '0.8.0' }),
      manifestEntry('packages/a/package.json', {
        name: '@fixture/a',
        version: '0.8.0',
        peerDependencies: { fixture: 'workspace:*' },
      }),
      manifestEntry('packages/b/package.json', {
        name: '@fixture/b',
        version: '0.8.0',
        peerDependencies: { fixture: 'workspace:>=0.9.0' },
      }),
    ]
    expect(peerFloorViolations(manifests, ['fixture'], '0.8.1')).toEqual([
      {
        manifestPath: 'packages/b/package.json',
        peerName: 'fixture',
        range: 'workspace:>=0.9.0',
      },
    ] satisfies PeerFloorViolation[])
  })

  test('throws on peer declarations it cannot evaluate', () => {
    const nonObject = [
      manifestEntry('package.json', { name: 'fixture', version: '0.8.0' }),
      manifestEntry('packages/a/package.json', {
        name: '@fixture/a',
        version: '0.8.0',
        peerDependencies: '>=0.9.0',
      }),
    ]
    expect(() => peerFloorViolations(nonObject, ['fixture'], '0.9.0')).toThrow(
      'packages/a/package.json: peerDependencies must be an object',
    )
    const nonString = [
      manifestEntry('package.json', { name: 'fixture', version: '0.8.0' }),
      manifestEntry('packages/b/package.json', {
        name: '@fixture/b',
        version: '0.8.0',
        peerDependencies: { fixture: 9 },
      }),
    ]
    expect(() => peerFloorViolations(nonString, ['fixture'], '0.9.0')).toThrow(
      'packages/b/package.json: peerDependencies.fixture must be a string',
    )
    const unparsable = [
      manifestEntry('package.json', { name: 'fixture', version: '0.8.0' }),
      manifestEntry('packages/c/package.json', {
        name: '@fixture/c',
        version: '0.8.0',
        peerDependencies: { fixture: 'not a range >>>' },
      }),
    ]
    expect(() => peerFloorViolations(unparsable, ['fixture'], '0.9.0')).toThrow(
      'peerDependencies.fixture is not a valid semver range: not a range >>>',
    )
  })

  test('the refusal names the version, each violating pair, and the way out', () => {
    const message = peerFloorRefusalMessage('0.8.1', [
      { manifestPath: 'packages/service/package.json', peerName: 'fixture', range: '>=0.9.0' },
    ])
    expect(message).toContain('cannot release 0.8.1')
    expect(message).toContain('packages/service/package.json: peer "fixture" requires >=0.9.0')
    expect(message).toContain('uninstallable from npm')
    expect(message).toContain('--minor')
  })

  test('refuses a patch release below a dependent package peer floor', async () => {
    const fixture = await createFixture({
      extraPackages: [{ path: 'packages/dep/package.json', text: dependentManifest('>=2.1.0') }],
    })
    await expectReleaseFailure(
      fixture.root,
      /cannot release 2\.0\.1[\s\S]*packages\/dep\/package\.json[\s\S]*peer "fixture" requires >=2\.1\.0[\s\S]*uninstallable/,
    )
  })

  test('refuses an explicit --version below the peer floor', async () => {
    const fixture = await createFixture({
      extraPackages: [{ path: 'packages/dep/package.json', text: dependentManifest('>=2.1.0') }],
    })
    await expectReleaseFailure(
      fixture.root,
      /cannot release 2\.0\.5[\s\S]*peer "fixture" requires >=2\.1\.0/,
      harness(),
      ['--version', '2.0.5'],
    )
  })

  test('a compliant minor bump passes the guard in a dry run', async () => {
    const fixture = await createFixture({
      extraPackages: [{ path: 'packages/dep/package.json', text: dependentManifest('>=2.1.0') }],
    })
    const testHarness = harness()
    await runRelease(['--minor', '--dry-run'], fixture.root, {
      run: testHarness.run,
      output: testHarness.output,
      today: () => '2026-07-27',
    })
    expect(testHarness.warnings.join('\n')).toBe('')
    expect(testHarness.logs.join('\n')).toContain(
      'Would publish fixture@2.1.0, @fixture/core@2.1.0, @fixture/dep@2.1.0 to the npm registry, in that order, as release-bot.',
    )
  })

  test('a private dependent with an unsatisfiable peer does not block the release', async () => {
    const fixture = await createFixture({
      extraPackages: [
        {
          path: 'packages/private-dep/package.json',
          text: '{\n  "name": "@fixture/private-dep",\n  "version": "2.0.0",\n  "private": true,\n  "peerDependencies": {\n    "fixture": "<2.0.0"\n  }\n}\n',
        },
      ],
    })
    const testHarness = harness()
    await runRelease(['--patch'], fixture.root, {
      run: testHarness.run,
      output: testHarness.output,
      today: () => '2026-07-27',
      repositoryUrl: fixture.remote,
      packageArchive: async () => new Uint8Array([1, 2, 3]),
    })
    const publishedLine = testHarness.logs.find((message) =>
      message.startsWith('Published fixture@2.0.1'),
    )
    expect(publishedLine).toBeDefined()
    expect(testHarness.logs.join('\n')).not.toContain('@fixture/private-dep')
    expect((await command(fixture.root, 'git', ['status', '--porcelain'])).stdout).toBe('')
  })
})

describe('release orchestration', () => {
  test('commits all release files, pushes an annotated tag, and publishes the exact cut section', async () => {
    const fixture = await createFixture()
    const testHarness = harness()
    const before = (await command(fixture.root, 'git', ['rev-parse', 'HEAD'])).stdout.trim()

    await runRelease(['--patch'], fixture.root, {
      run: testHarness.run,
      output: testHarness.output,
      today: () => '2026-07-27',
      repositoryUrl: fixture.remote,
      // The real packer runs outside the command seam; this stub only proves
      // the upload uses the injected bytes.
      packageArchive: async () => new Uint8Array([1, 2, 3]),
    })

    const cloneRequests = testHarness.requests.filter(
      (request) => request.command === 'git' && request.args[0] === 'clone',
    )
    expect(cloneRequests).toHaveLength(2)
    expect(cloneRequests.map((request) => request.args.at(-2))).toEqual([
      fixture.root,
      fixture.remote,
    ])
    for (const clone of cloneRequests) {
      expect(clone.args).toContain('v2.0.1')
      expect(existsSync(String(clone.args.at(-1)))).toBe(false)
    }
    const smokeBunRequests = testHarness.requests.filter(
      (request) =>
        request.command === 'bun' && request.args[0] !== 'pm' && request.args[0] !== 'publish',
    )
    expect(smokeBunRequests).toHaveLength(4)
    // Every publishable package is published last, in dependency order, from
    // its own directory, and only after the GitHub Release exists.
    const publishRequests = testHarness.requests.filter(
      (request) => request.command === 'bun' && request.args[0] === 'publish',
    )
    expect(publishRequests.map((request) => request.cwd)).toEqual([
      fixture.root,
      join(fixture.root, 'packages', 'core'),
    ])
    for (const request of publishRequests) {
      expect(request.args).toEqual(['publish', '--access', 'public', '--ignore-scripts'])
    }
    const lastGhIndex = testHarness.requests.map((request) => request.command).lastIndexOf('gh')
    expect(testHarness.requests.indexOf(publishRequests[0]!)).toBeGreaterThan(lastGhIndex)
    // The guest distribution archive is packed by the injected packageArchive
    // (the production packer runs outside the command seam) and uploaded to
    // the release under the published asset name — no in-process `bun pm pack`.
    expect(
      testHarness.requests.some(
        (request) =>
          request.command === 'bun' && request.args[0] === 'pm' && request.args[1] === 'pack',
      ),
    ).toBe(false)
    const uploadRequest = testHarness.requests.find(
      (request) =>
        request.command === 'gh' && request.args[0] === 'release' && request.args[1] === 'upload',
    )
    expect(uploadRequest?.args[2]).toBe('v2.0.1')
    expect(String(uploadRequest?.args[3])).toMatch(/autobuild-2\.0\.1\.tgz$/)
    expect(
      smokeBunRequests.filter(
        (request) => request.args.join(' ') === 'run --silent postgres:migrate',
      ),
    ).toHaveLength(2)
    for (const request of smokeBunRequests) {
      expect(request.env).toBeDefined()
      expect(request.env).not.toHaveProperty('AB_POSTGRES_URL')
      expect(request.env).not.toHaveProperty('DATABASE_URL')
    }
    const pushIndex = testHarness.requests.findIndex(
      (request) => request.command === 'git' && request.args[0] === 'push',
    )
    const remoteCloneIndex = testHarness.requests.indexOf(cloneRequests[1]!)
    const ghIndex = testHarness.requests.findIndex((request) => request.command === 'gh')
    expect(testHarness.requests.indexOf(cloneRequests[0]!)).toBeLessThan(pushIndex)
    expect(pushIndex).toBeLessThan(remoteCloneIndex)
    expect(remoteCloneIndex).toBeLessThan(ghIndex)

    const claude = testHarness.requests.find((request) => request.command === 'claude')
    expect(claude?.args.slice(0, 4)).toEqual(['-p', '--tools', '', '--'])
    expect(claude?.args).toHaveLength(5)
    expect(claude?.args.at(-1)).toContain(
      '- [#2](https://example.test/2) — New capability\n- [#1](https://example.test/1) — Important repair',
    )

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
    ).toEqual(['CHANGELOG.md', 'README.md', 'package.json', 'packages/core/package.json'])
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
    expect(await readFile(join(fixture.root, 'packages/core/package.json'), 'utf8')).toContain(
      '"version": "2.0.1"',
    )
    expect(await readFile(join(fixture.root, 'README.md'), 'utf8')).toContain(
      '@defrex/autobuild@2.0.1',
    )
    expect((await command(fixture.root, 'git', ['status', '--porcelain'])).stdout).toBe('')
  })

  test('a local-tag migration smoke failure rolls back the commit and unpushed tag', async () => {
    const fixture = await createFixture()
    const testHarness = harness()
    const normalRun = testHarness.run
    testHarness.run = async (request) => {
      if (request.command === 'bun' && request.args[0] === 'install') {
        testHarness.requests.push(request)
        return { exitCode: 1, stdout: '', stderr: 'deterministic install failure' }
      }
      return normalRun(request)
    }

    await expectReleaseFailure(
      fixture.root,
      /could not install v2\.0\.1 smoke checkout/,
      testHarness,
    )
    expect((await command(fixture.root, 'git', ['tag', '--list', 'v2.0.1'])).stdout).toBe('')
    const clone = testHarness.requests.find(
      (request) => request.command === 'git' && request.args[0] === 'clone',
    )
    expect(clone).toBeDefined()
    expect(existsSync(String(clone?.args.at(-1)))).toBe(false)
    expect(testHarness.requests.some((request) => request.command === 'gh')).toBe(false)
  })

  test('a remote-tag smoke failure preserves pushed refs and prints both recovery stages', async () => {
    const fixture = await createFixture()
    const testHarness = harness()
    const normalRun = testHarness.run
    testHarness.run = async (request) => {
      if (
        request.command === 'git' &&
        request.args[0] === 'clone' &&
        request.args.at(-2) === fixture.remote
      ) {
        testHarness.requests.push(request)
        return { exitCode: 1, stdout: '', stderr: 'remote temporarily unavailable' }
      }
      return normalRun(request)
    }
    let error: unknown
    try {
      await runRelease(['--patch'], fixture.root, {
        run: testHarness.run,
        output: testHarness.output,
        today: () => '2026-07-27',
        repositoryUrl: fixture.remote,
      })
    } catch (caught) {
      error = caught
    }

    const message = thrownMessage(error)
    expect(message).toContain('canonical GitHub-tag migration smoke failed')
    expect(message).toContain('https://github.com/defrex/autobuild.git')
    expect(message).toContain('bun install --frozen-lockfile')
    expect(message).toContain('env -u AB_POSTGRES_URL -u DATABASE_URL')
    expect(message).toContain('gh release create v2.0.1')
    expect(testHarness.requests.some((request) => request.command === 'gh')).toBe(false)
    const head = (await command(fixture.root, 'git', ['rev-parse', 'HEAD'])).stdout.trim()
    expect(
      (await command(fixture.root, 'git', ['ls-remote', 'origin', 'refs/heads/main'])).stdout,
    ).toStartWith(head)
    expect(
      (await command(fixture.root, 'git', ['ls-remote', 'origin', 'refs/tags/v2.0.1^{}'])).stdout,
    ).toStartWith(head)
    const failedClone = testHarness.requests.find(
      (request) =>
        request.command === 'git' &&
        request.args[0] === 'clone' &&
        request.args.at(-2) === fixture.remote,
    )
    expect(existsSync(String(failedClone?.args.at(-1)))).toBe(false)
  })

  test('a post-push GitHub failure prints the exact notes in a verbatim retry command', async () => {
    const fixture = await createFixture()
    const testHarness = harness(undefined, {
      exitCode: 1,
      stdout: '',
      stderr: 'temporary GitHub failure',
    })
    let error: unknown

    try {
      await runRelease(['--patch'], fixture.root, {
        run: testHarness.run,
        output: testHarness.output,
        today: () => '2026-07-27',
        repositoryUrl: fixture.remote,
      })
    } catch (caught) {
      error = caught
    }

    const message = thrownMessage(error)
    const exactNotes =
      '## v2.0.1 — 2026-07-27\n\nThis release adds a new capability and delivers an important repair.\n\n' +
      '- [#2](https://example.test/2) — New capability\n' +
      '- [#1](https://example.test/1) — Important repair\n'
    expect(message).toContain('main and v2.0.1 were pushed')
    expect(message).toContain('Do not rewrite or delete the public refs')
    expect(message).toContain(
      "gh release create v2.0.1 --verify-tag --title v2.0.1 --notes-file - <<'AUTOBUILD_RELEASE_NOTES'",
    )
    expect(message).toContain(`${exactNotes}AUTOBUILD_RELEASE_NOTES`)

    const head = (await command(fixture.root, 'git', ['rev-parse', 'HEAD'])).stdout.trim()
    expect(
      (await command(fixture.root, 'git', ['ls-remote', 'origin', 'refs/heads/main'])).stdout,
    ).toStartWith(head)
    expect(
      (await command(fixture.root, 'git', ['ls-remote', 'origin', 'refs/tags/v2.0.1^{}'])).stdout,
    ).toStartWith(head)
    expect((await command(fixture.root, 'git', ['status', '--porcelain'])).stdout).toBe('')
  })

  test('dry-run runs gates and Claude but leaves files, HEAD, refs, remote, and release calls unchanged', async () => {
    const fixture = await createFixture()
    const testHarness = harness()
    const files = await Promise.all(
      ['CHANGELOG.md', 'README.md', 'package.json', 'packages/core/package.json'].map((path) =>
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
        ['CHANGELOG.md', 'README.md', 'package.json', 'packages/core/package.json'].map((path) =>
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
    expect(testHarness.logs.join('\n')).toContain('bun add -g @defrex/autobuild@2.1.0')
    expect(testHarness.logs.join('\n')).toContain(
      'Would publish fixture@2.1.0, @fixture/core@2.1.0 to the npm registry, in that order, as release-bot.',
    )
    expect(
      testHarness.requests.some(
        (request) => request.command === 'bun' && request.args[0] === 'publish',
      ),
    ).toBe(false)
    expect(testHarness.logs.join('\n')).toContain('--- packages/core/package.json (candidate) ---')
  })

  test('refuses version skew before mutating release files', async () => {
    const fixture = await createFixture()
    await writeFile(
      join(fixture.root, 'packages', 'core', 'package.json'),
      '{\n  "name": "@fixture/core",\n  "version": "2.0.1"\n}\n',
    )
    await command(fixture.root, 'git', ['add', 'packages/core/package.json'])
    await command(fixture.root, 'git', ['commit', '-m', 'skew fixture'])
    await command(fixture.root, 'git', ['push', 'origin', 'main'])
    await expectReleaseFailure(fixture.root, /version must match root 2\.0\.0 before releasing/)
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
        repositoryUrl: fixture.remote,
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

describe('distribution asset upload', () => {
  test('uploads the production-packed archive whose manifest omits patchedDependencies and devDependencies', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'autobuild-release-upload-'))
    temporaryDirectories.push(destination)
    const logs: string[] = []
    let uploadedBytes: Uint8Array | undefined
    const run: CommandRunner = async (request) => {
      if (
        request.command === 'gh' &&
        request.args[0] === 'release' &&
        request.args[1] === 'upload'
      ) {
        // Capture the bytes during the intercepted upload: the packer's
        // staging directory is removed when uploadDistributionAsset returns.
        uploadedBytes = new Uint8Array(await readFile(String(request.args[3])))
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (request.command === 'gh' && request.args[0] === 'release' && request.args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ assets: [{ name: 'autobuild-2.0.1.tgz', size: 1234 }] }),
          stderr: '',
        }
      }
      throw new Error(`unexpected command: ${request.command} ${request.args.join(' ')}`)
    }

    // The default packageArchive is the production packer
    // (packageAutobuildDistribution) — the same bytes a real release uploads.
    await uploadDistributionAsset(run, destination, 'v2.0.1', '2.0.1', {
      log: (message) => logs.push(message),
      warn: () => {},
    })

    expect(uploadedBytes!.length).toBeGreaterThan(0)
    const archive = join(destination, 'autobuild-2.0.1.tgz')
    await writeFile(archive, uploadedBytes!)
    const manifestProcess = Bun.spawn(['tar', '-xOf', archive, 'package/package.json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const packedManifest = JSON.parse(await new Response(manifestProcess.stdout).text()) as {
      patchedDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(await manifestProcess.exited).toBe(0)
    // The published release asset must not carry the repo's
    // patchedDependencies declaration: a consumer installing it next to
    // better-auth panics bun (finding f_812bb6b5).
    expect(packedManifest.patchedDependencies).toBeUndefined()
    // Nor its devDependencies: the guest installs --production (which ignores
    // them), and the workspace-link specifiers they may carry are unresolvable
    // in the packer's staging tree. The staging pack fails outright if a
    // workspace specifier ever leaks into the packed manifest.
    expect(packedManifest.devDependencies).toBeUndefined()
    expect(logs.join('\n')).toContain('Uploaded autobuild-2.0.1.tgz (1234 bytes)')
  }, 60_000)
})

describe('npm publication', () => {
  test('orders publishable packages after their workspace dependencies and skips private ones', () => {
    const packages = publishablePackages([
      { path: 'package.json', text: '{"name":"@acme/cli","version":"1.0.0"}' },
      {
        path: 'packages/service/package.json',
        text: '{"name":"@acme/service","dependencies":{"@acme/store":"workspace:*"},"peerDependencies":{"@acme/cli":">=1"}}',
      },
      { path: 'packages/store/package.json', text: '{"name":"@acme/store"}' },
      { path: 'packages/private/package.json', text: '{"name":"@acme/private","private":true}' },
      // A plugin peering on the root package (AUT-517): publishable, and it
      // must not create a root ↔ provider cycle.
      {
        path: 'packages/plugin/package.json',
        text: '{"name":"@acme/plugin","peerDependencies":{"@acme/cli":">=1"}}',
      },
    ])
    expect(packages.map((entry) => [entry.name, entry.directory])).toEqual([
      ['@acme/cli', '.'],
      ['@acme/store', 'packages/store'],
      ['@acme/service', 'packages/service'],
      ['@acme/plugin', 'packages/plugin'],
    ])
    expect(publishRecoveryCommand(packages.slice(1))).toBe(
      '(cd packages/store && bun publish --access public --ignore-scripts)\n' +
        '(cd packages/service && bun publish --access public --ignore-scripts)\n' +
        '(cd packages/plugin && bun publish --access public --ignore-scripts)',
    )
  })

  test('the real workspace manifests order without a root ↔ provider cycle (AUT-517)', async () => {
    const manifests = await readWorkspaceManifests(repoRoot)
    const packages = publishablePackages(manifests)
    const names = packages.map((entry) => entry.name)
    // Every publishable workspace package appears exactly once, and the
    // ordering completes without the cycle error.
    const publishable = new Set(
      manifests
        .filter((manifest) => manifest.manifest.private !== true)
        .map((manifest) => manifest.manifest.name as string),
    )
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(names)).toEqual(publishable)
    // The plugin peers on the root package, so it must publish after it —
    // deliberately NOT asserted "last among dependents of the root": with
    // every sub-package peering on the root, the real order is root,
    // postgres-store, vercel-sandbox, hosted-store-service,
    // hosted-dispatcher.
    expect(names.indexOf('@defrex/autobuild-vercel-sandbox')).toBeGreaterThan(
      names.indexOf('@defrex/autobuild'),
    )
  })

  test('refuses to release without a registry login, before any gate runs', async () => {
    const fixture = await createFixture()
    const testHarness = harness(undefined, undefined, {
      whoami: { exitCode: 1, stdout: '', stderr: 'error: not logged in' },
      publish: { exitCode: 0, stdout: '', stderr: '' },
    })
    await expectReleaseFailure(fixture.root, /npm registry login required/, testHarness)
    expect(testHarness.requests.some((request) => request.command === 'claude')).toBe(false)
    expect(testHarness.requests.some((request) => request.args.join(' ').includes('lint'))).toBe(
      false,
    )
  })

  test('a failed publish keeps the public refs and names the packages still unpublished', async () => {
    const fixture = await createFixture()
    const testHarness = harness(undefined, undefined, {
      whoami: { exitCode: 0, stdout: 'release-bot\n', stderr: '' },
      publish: { exitCode: 1, stdout: '', stderr: 'error: 403 Forbidden' },
    })
    const message = await runRelease(['--patch'], fixture.root, {
      run: testHarness.run,
      output: testHarness.output,
      today: () => '2026-07-27',
      repositoryUrl: fixture.remote,
    }).then(
      () => '',
      (error: unknown) => thrownMessage(error),
    )
    expect(message).toContain('publishing fixture@2.0.1 failed: error: 403 Forbidden')
    expect(message).toContain('do not rewrite them')
    expect(message).toContain('bun publish --access public --ignore-scripts')
    expect(message).toContain('(cd packages/core && bun publish --access public --ignore-scripts)')
    expect((await command(fixture.root, 'git', ['tag', '--list'])).stdout.trim()).toBe('v2.0.1')
    expect(
      (await command(fixture.root, 'git', ['ls-remote', '--tags', 'origin'])).stdout,
    ).toContain('refs/tags/v2.0.1')
  })
})
