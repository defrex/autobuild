import { expect, test } from 'bun:test'
import {
  normalizeClaudeSummary,
  parseReleaseArguments,
  peerFloorRefusalMessage,
  peerFloorViolations,
  publishablePackages,
  publishRecoveryCommand,
  README_INSTALL_END,
  README_INSTALL_START,
  releasePolicy,
  renderReleasedChangelog,
  replaceHostedServicePins,
  replacePackageVersion,
  replaceReadmeInstall,
  resolveReleaseVersion,
  type PeerFloorViolation,
} from './release'
import type { WorkspaceManifest } from './workspace-manifest-check'

const fixtureReadme = `# Fixture

${README_INSTALL_START}

\`\`\`sh
bun add -g @defrex/autobuild@0.0.0
\`\`\`

${README_INSTALL_END}
`

const fixtureChangelog = `# Changelog

## Unreleased

- [#2](https://example.test/2) — New capability
- [#1](https://example.test/1) — Important repair
`

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
  expect(replaced).toBe(
    fixtureReadme.replace(
      'bun add -g @defrex/autobuild@0.0.0',
      'bun add -d --exact @defrex/autobuild@2.1.0',
    ),
  )
  expect(replaced).not.toContain('github:')
  expect(replaced.match(/release-install:start/g)).toHaveLength(1)
  expect(() => replaceReadmeInstall('# no markers\n', '2.1.0')).toThrow('exactly one')
  for (const marker of [README_INSTALL_START, README_INSTALL_END]) {
    expect(() => replaceReadmeInstall(`${fixtureReadme}${marker}`, '2.1.0')).toThrow('exactly one')
  }
  expect(() =>
    replaceReadmeInstall(`${README_INSTALL_END}\n${README_INSTALL_START}`, '2.1.0'),
  ).toThrow('out of order')
  expect(replacePackageVersion('{\n  "version": "2.0.0"\n}\n', '2.1.0')).toBe(
    '{\n  "version": "2.1.0"\n}\n',
  )
})

function manifestEntry(path: string, manifest: Record<string, unknown>): WorkspaceManifest {
  return {
    path,
    text: JSON.stringify(manifest),
    manifest: manifest as WorkspaceManifest['manifest'],
  }
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

test('derives channels and resolves stable targets from beta', () => {
  expect(releasePolicy('1.0.0-beta.0')).toEqual({ prerelease: true, distTag: 'beta' })
  expect(releasePolicy('1.0.0-rc.2')).toEqual({ prerelease: true, distTag: 'rc' })
  for (const identifier of ['0', '99999999999999999999', 'latest', 'x', 'v1']) {
    expect(() => releasePolicy(`1.0.0-${identifier}`)).toThrow(identifier)
  }
  for (const selector of [{ version: '1.0.0' }, { bump: 'major' as const }]) {
    expect(resolveReleaseVersion('1.0.0-beta.2', { dryRun: false, ...selector })).toBe('1.0.0')
  }
})

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
test('releases bump exact deployment pins without changing source peer floors', () => {
  const template = replaceHostedServicePins(
    JSON.stringify({
      dependencies: {
        '@defrex/autobuild': '0.11.0',
        '@defrex/autobuild-hosted-store-service': '0.11.0',
        next: '16.1.6',
      },
    }),
    '0.12.0',
  )
  expect(JSON.parse(template).dependencies).toEqual({
    '@defrex/autobuild': '0.12.0',
    '@defrex/autobuild-hosted-store-service': '0.12.0',
    next: '16.1.6',
  })
  const service = {
    version: '0.11.0',
    peerDependencies: { '@defrex/autobuild': '>=0.11.0' },
  }
  expect(JSON.parse(replacePackageVersion(JSON.stringify(service, null, 2), '0.12.0'))).toEqual({
    ...service,
    version: '0.12.0',
  })
})
