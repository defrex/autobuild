import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  type PackRequest,
  type PackResult,
  type PackRunner,
  type PublishContentsCheckEnvironment,
  type PublishContentsCheckOutput,
  type TarballRuling,
  deriveRuledPackages,
  evaluatePackedPaths,
  matchesPackedPattern,
  packedTargetsFromManifest,
  parsePackedPaths,
  runPublishContentsCheck,
} from './publish-contents-check'

/**
 * Byte-shaped after the real bun 1.4.0 output this check parses: the banner,
 * `packed <size> <path>` lines with size spellings (`320B`, `2.1KB`) and
 * bracketed route paths, the tgz-name line, and the totals trailer. The
 * listing is trimmed to representative files; the parser keys on the line
 * shape, not the count.
 */
const happyListing = [
  'bun pack v1.4.0 (34cbb9a40)',
  '',
  'packed 2.11KB package.json',
  'packed 10.78KB README.md',
  'packed 4.1KB src/bin.ts',
  'packed 320B src/web/runtime.ts',
  'packed 1.59KB src/app-route-with-brackets/[...all]/route.ts',
  '',
  'defrex-autobuild-hosted-store-service-0.8.0.tgz',
  '',
  'Total files: 6',
  'Unpacked size: 0.02MB',
  '',
].join('\n')

/** The pre-ruling listing shape: the moved checkout/Vercel surface present. */
const leakedListing = [
  'bun pack v1.4.0 (34cbb9a40)',
  '',
  'packed 2.1KB package.json',
  'packed 10.1KB README.md',
  'packed 2.58KB .impeccable/surfaces/app-dashboard-dashboardclient-tsx.md',
  'packed 0.59KB app/api/auth/[...all]/route.ts',
  'packed 246B next-env.d.ts',
  'packed 2.1KB next.config.ts',
  'packed 272B server.ts',
  'packed 271B tsconfig.json',
  'packed 308B vercel.json',
  'packed 4.1KB src/bin.ts',
  '',
  'defrex-autobuild-hosted-store-service-0.8.0.tgz',
  '',
  'Total files: 12',
  'Unpacked size: 0.03MB',
].join('\n')

/** The postgres-store ruling shape: package.json, README.md, and every src target. */
const postgresHappyListing = [
  'bun pack v1.4.0 (34cbb9a40)',
  '',
  'packed 0.88KB package.json',
  'packed 3.64KB README.md',
  'packed 0.60KB src/bin.ts',
  'packed 1.27KB src/env.ts',
  'packed 1.14KB src/index.ts',
  'packed 49.71KB src/schema.ts',
  'packed 46.30KB src/store.ts',
  '',
  'defrex-autobuild-postgres-store-0.8.0.tgz',
  '',
  'Total files: 7',
  'Unpacked size: 0.1MB',
].join('\n')

/** A future top-level file riding into the postgres-store tarball. */
const postgresLeakedListing = [
  'bun pack v1.4.0 (34cbb9a40)',
  '',
  'packed 0.88KB package.json',
  'packed 3.64KB README.md',
  'packed 0.6KB scratch.ts',
  'packed 1.14KB src/index.ts',
  'packed 46.30KB src/store.ts',
  '',
  'defrex-autobuild-postgres-store-0.8.0.tgz',
  '',
  'Total files: 6',
  'Unpacked size: 0.09MB',
].join('\n')

/* ------------------------------------------------------------------ */
/* The fake workspace: the real publishable set, trimmed. The ruled     */
/* set and every ruling are derived from these manifests, so the        */
/* fixtures mirror the real shapes (private core, dep ordering, the     */
/* root manifest's negated test-file entry).                            */
/* ------------------------------------------------------------------ */

const rootFixtureManifest = {
  name: '@defrex/autobuild',
  version: '0.8.0',
  publishConfig: { access: 'public' },
  dependencies: { zod: '^4.4.3' },
  exports: {
    './cli': {
      types: './packages/core/src/cli/dispatch.ts',
      import: './packages/core/src/cli/dispatch.ts',
    },
    './store-adapter': {
      types: './packages/core/src/store/adapter.ts',
      import: './packages/core/src/store/adapter.ts',
    },
  },
  bin: { ab: 'bin/ab.ts' },
  files: [
    'bin',
    'packages/core/src',
    '!packages/core/src/**/*.test.ts',
    'skills',
    'templates',
    'patches',
    'LICENSE',
    'README.md',
    'SPEC.md',
    'docs',
  ],
}

const coreFixtureManifest = {
  name: '@defrex/autobuild-core',
  private: true,
  exports: { '.': './src/index.ts' },
}

const postgresFixtureManifest = {
  name: '@defrex/autobuild-postgres-store',
  version: '0.8.0',
  publishConfig: { access: 'public' },
  peerDependencies: { '@defrex/autobuild': '>=0.7.0' },
  exports: {
    '.': { types: './src/index.ts', import: './src/index.ts' },
    './env': { types: './src/env.ts', import: './src/env.ts' },
    './schema': { types: './src/schema.ts', import: './src/schema.ts' },
    './store': { types: './src/store.ts', import: './src/store.ts' },
  },
  bin: { 'ab-postgres-store': './src/bin.ts' },
  files: ['src', 'README.md'],
}

const hostedFixtureManifest = {
  name: '@defrex/autobuild-hosted-store-service',
  version: '0.8.0',
  publishConfig: { access: 'public' },
  dependencies: { '@defrex/autobuild-postgres-store': 'workspace:*' },
  peerDependencies: { '@defrex/autobuild': '>=0.9.0' },
  exports: {
    '.': { types: './src/index.ts', import: './src/index.ts' },
    './service': { types: './src/service.ts', import: './src/service.ts' },
    './operator-api': { types: './src/operator-api.ts', import: './src/operator-api.ts' },
    './remote-tickets': { types: './src/remote-tickets.ts', import: './src/remote-tickets.ts' },
    './web/auth': { types: './src/web/auth.ts', import: './src/web/auth.ts' },
    './web/config': { types: './src/web/config.ts', import: './src/web/config.ts' },
    './web/runtime': { types: './src/web/runtime.ts', import: './src/web/runtime.ts' },
    './web/mcp': { types: './src/web/mcp.ts', import: './src/web/mcp.ts' },
  },
  bin: { 'ab-hosted-store': './src/bin.ts' },
  files: ['src', 'README.md'],
}

const dispatcherFixtureManifest = {
  name: '@defrex/autobuild-hosted-dispatcher',
  version: '0.8.0',
  publishConfig: { access: 'public' },
  peerDependencies: {
    '@defrex/autobuild': '>=0.9.0',
    '@defrex/autobuild-hosted-store-service': '>=0.9.0',
  },
  exports: {
    '.': { types: './src/index.ts', import: './src/index.ts' },
    './dispatcher': { types: './src/dispatcher.ts', import: './src/dispatcher.ts' },
    './runtime': { types: './src/runtime.ts', import: './src/runtime.ts' },
    './distribution': {
      types: './src/ship-packed-distribution.ts',
      import: './src/ship-packed-distribution.ts',
    },
  },
  bin: { 'ab-hosted-dispatcher': './src/bin.ts' },
  files: ['src', 'README.md'],
}

const fakeWorkspaceManifests = (): { path: string; text: string }[] => [
  { path: 'package.json', text: JSON.stringify(rootFixtureManifest) },
  { path: 'packages/core/package.json', text: JSON.stringify(coreFixtureManifest) },
  {
    path: 'packages/hosted-dispatcher/package.json',
    text: JSON.stringify(dispatcherFixtureManifest),
  },
  {
    path: 'packages/hosted-store-service/package.json',
    text: JSON.stringify(hostedFixtureManifest),
  },
  { path: 'packages/postgres-store/package.json', text: JSON.stringify(postgresFixtureManifest) },
]

/** The root manifest's negated entry, as a glob the matcher must honor. */
const rootDenialPattern = 'packages/core/src/**/*.test.ts'

const derivedFixtures = deriveRuledPackages(fakeWorkspaceManifests())

function rulingFor(directory: string): TarballRuling {
  const derived = derivedFixtures.find(
    (entry) => entry.kind === 'ruled' && entry.ruling.directory === directory,
  )
  if (derived === undefined || derived.kind !== 'ruled') {
    throw new Error(`no fixture ruling for ${directory}`)
  }
  return derived.ruling
}

const rootRuling = rulingFor('.')
const dispatcherRuling = rulingFor('packages/hosted-dispatcher')
const hostedRuling = rulingFor('packages/hosted-store-service')
const postgresRuling = rulingFor('packages/postgres-store')

describe('matchesPackedPattern', () => {
  test('** matches zero middle segments', () => {
    expect(matchesPackedPattern('packages/core/src/ids.test.ts', rootDenialPattern)).toBe(true)
  })

  test('** matches multiple middle segments', () => {
    expect(matchesPackedPattern('packages/core/src/cli/args.test.ts', rootDenialPattern)).toBe(true)
  })

  test('the denial does not match non-test files, other trees, or directories', () => {
    expect(matchesPackedPattern('packages/core/src/cli/args.ts', rootDenialPattern)).toBe(false)
    expect(matchesPackedPattern('packages/core/src/testing/index.ts', rootDenialPattern)).toBe(
      false,
    )
    expect(matchesPackedPattern('bin/ab.ts', rootDenialPattern)).toBe(false)
  })

  test('* matches within a segment only', () => {
    expect(matchesPackedPattern('src/ids.test.ts', 'src/*.test.ts')).toBe(true)
    expect(matchesPackedPattern('src/web/ids.test.ts', 'src/*.test.ts')).toBe(false)
  })

  test('a pattern without globs matches exactly', () => {
    expect(matchesPackedPattern('LICENSE', 'LICENSE')).toBe(true)
    expect(matchesPackedPattern('LICENSE.md', 'LICENSE')).toBe(false)
    expect(matchesPackedPattern('LICENSE', 'LICENSE.md')).toBe(false)
  })

  test('regex metacharacters in a pattern are literal', () => {
    expect(
      matchesPackedPattern('patches/better-auth@1.4.18.patch', 'patches/better-auth@1.4.18.patch'),
    ).toBe(true)
    expect(
      matchesPackedPattern('patches/better-authx1x4x18xpatch', 'patches/better-auth@1.4.18.patch'),
    ).toBe(false)
  })
})

describe('deriveRuledPackages', () => {
  test('every publishable manifest yields a ruling, in publish order', () => {
    const names = derivedFixtures.map((entry) =>
      entry.kind === 'ruled' ? entry.ruling.name : entry.name,
    )
    expect(names).toEqual([
      '@defrex/autobuild',
      '@defrex/autobuild-postgres-store',
      '@defrex/autobuild-hosted-store-service',
      '@defrex/autobuild-hosted-dispatcher',
    ])
  })

  test('private manifests are never ruled', () => {
    const names = derivedFixtures.map((entry) =>
      entry.kind === 'ruled' ? entry.ruling.name : entry.name,
    )
    expect(names).not.toContain('@defrex/autobuild-core')
  })

  test('surfaces and denied patterns parse per package', () => {
    expect(rootRuling.allowedSurfaces).toEqual([
      'bin',
      'packages/core/src',
      'skills',
      'templates',
      'patches',
      'LICENSE',
      'README.md',
      'SPEC.md',
      'docs',
    ])
    expect(rootRuling.deniedPackedPatterns).toEqual(['packages/core/src/**/*.test.ts'])
    expect(rootRuling.requiredPackedPaths).toEqual(['package.json', 'README.md'])
    expect(rootRuling.directory).toBe('.')

    expect(postgresRuling.allowedSurfaces).toEqual(['src', 'README.md'])
    expect(postgresRuling.deniedPackedPatterns).toEqual([])
    expect(postgresRuling.directory).toBe('packages/postgres-store')
  })

  test('the store rulings keep their pinned prose; the rest derive theirs', () => {
    expect(hostedRuling.ruling).toContain('Ruling (AUT-463)')
    expect(postgresRuling.ruling).toContain('Ruling (AUT-473)')
    expect(rootRuling.ruling).toContain('Ruling (derived from the manifest)')
    expect(rootRuling.ruling).toContain('@defrex/autobuild')
    expect(rootRuling.ruling).toContain('package.json')
  })

  test('leading ./ and trailing / on an entry do not change what it rules', () => {
    const derived = deriveRuledPackages([
      {
        path: 'package.json',
        text: JSON.stringify({ name: 'x', exports: {}, files: ['./src/', '!./secret/'] }),
      },
    ])
    const first = derived[0]
    if (first === undefined || first.kind !== 'ruled') throw new Error('expected a ruling')
    expect(first.ruling.allowedSurfaces).toEqual(['src'])
    expect(first.ruling.deniedPackedPatterns).toEqual(['secret'])
  })

  test('a non-string files entry is a hard derivation failure naming the manifest', () => {
    expect(() =>
      deriveRuledPackages([
        {
          path: 'package.json',
          text: JSON.stringify({ name: 'x', exports: {}, files: ['src', 42] }),
        },
      ]),
    ).toThrow("every 'files' entry must be a string")
  })

  test('a manifest with no files array is a no-files-allowlist marker, in publish order', () => {
    const derived = deriveRuledPackages([
      { path: 'package.json', text: JSON.stringify({ name: 'x', exports: {} }) },
    ])
    expect(derived).toEqual([
      {
        kind: 'no-files-allowlist',
        name: 'x',
        directory: '.',
        ruling: expect.stringContaining('Ruling (derived from the manifest)'),
      },
    ])
  })
})

describe('parsePackedPaths', () => {
  test('extracts every path from a real-shaped listing and ignores the trailer lines', () => {
    expect(parsePackedPaths(happyListing)).toEqual([
      'package.json',
      'README.md',
      'src/bin.ts',
      'src/web/runtime.ts',
      'src/app-route-with-brackets/[...all]/route.ts',
    ])
  })

  test('a listing with no packed lines yields nothing, which the evaluation fails on', () => {
    const bannerOnly = ['bun pack v1.4.0 (34cbb9a40)', '', 'no files', ''].join('\n')
    expect(parsePackedPaths(bannerOnly)).toEqual([])
  })

  test('handles CRLF endings and dot-prefixed directories', () => {
    expect(parsePackedPaths('packed 2.58KB .impeccable/surfaces/brief.md\r\n')).toEqual([
      '.impeccable/surfaces/brief.md',
    ])
  })
})

/** The real root-shaped listing, trimmed to representative files: the always-packed
 * two, the file surfaces (LICENSE, SPEC.md), and at least one packed path under
 * every directory surface. */
const rootConformPaths = [
  'package.json',
  'README.md',
  'LICENSE',
  'SPEC.md',
  'bin/ab.ts',
  'bin/ab-dev.ts',
  'packages/core/src/cli/dispatch.ts',
  'packages/core/src/store/adapter.ts',
  'packages/core/src/ids.ts',
  'docs/README.md',
  'skills/spec/SKILL.md',
  'templates/autobuild.toml',
  'patches/better-auth@1.4.18.patch',
]

describe('evaluatePackedPaths', () => {
  test('the hosted-store ruling-shaped listing (package.json, README.md, src/**) passes', () => {
    expect(evaluatePackedPaths(parsePackedPaths(happyListing), hostedRuling)).toEqual([])
  })

  test('every moved checkout/Vercel artifact is an extra, named by path', () => {
    const violations = evaluatePackedPaths(parsePackedPaths(leakedListing), hostedRuling)
    const extras = violations
      .filter((violation) => violation.kind === 'extra')
      .map((violation) => (violation.kind === 'extra' ? violation.path : ''))
    expect(extras).toEqual([
      '.impeccable/surfaces/app-dashboard-dashboardclient-tsx.md',
      'app/api/auth/[...all]/route.ts',
      'next-env.d.ts',
      'next.config.ts',
      'server.ts',
      'tsconfig.json',
      'vercel.json',
    ])
  })

  test('the real root-shaped listing passes against the derived root ruling', () => {
    expect(evaluatePackedPaths(rootConformPaths, rootRuling)).toEqual([])
  })

  test('a test file under packages/core/src is denied for the root package even though the surface allows it', () => {
    const violations = evaluatePackedPaths(
      [...rootConformPaths, 'packages/core/src/cli/args.test.ts'],
      rootRuling,
    )
    expect(violations).toEqual([{ kind: 'extra', path: 'packages/core/src/cli/args.test.ts' }])
  })

  test('a listing missing src/ fails with missing-surface, naming the entry, not silently', () => {
    const violations = evaluatePackedPaths(['package.json', 'README.md'], postgresRuling)
    expect(violations).toEqual([{ kind: 'missing-surface', entry: 'src' }])
  })

  test('a dispatcher-shaped listing missing its src surface fails with missing-surface', () => {
    const violations = evaluatePackedPaths(['package.json', 'README.md'], dispatcherRuling)
    expect(violations).toEqual([{ kind: 'missing-surface', entry: 'src' }])
  })

  test('a file-type surface that packs nothing fails with missing-surface too', () => {
    const withoutLicense = rootConformPaths.filter((path) => path !== 'LICENSE')
    const violations = evaluatePackedPaths(withoutLicense, rootRuling)
    expect(violations).toEqual([{ kind: 'missing-surface', entry: 'LICENSE' }])
  })

  test('a listing missing a required file names it', () => {
    const violations = evaluatePackedPaths(['README.md', 'src/bin.ts'], hostedRuling)
    expect(violations).toEqual([{ kind: 'missing', path: 'package.json' }])
  })

  test('an empty parsed listing fails as empty-listing, never as a pass', () => {
    expect(evaluatePackedPaths([], hostedRuling)).toEqual([{ kind: 'empty-listing' }])
  })

  test('the postgres-store ruling-shaped listing passes against the postgres ruling', () => {
    expect(evaluatePackedPaths(parsePackedPaths(postgresHappyListing), postgresRuling)).toEqual([])
  })

  test('a top-level file added to the postgres-store directory is an extra, named by path', () => {
    const violations = evaluatePackedPaths(parsePackedPaths(postgresLeakedListing), postgresRuling)
    expect(violations).toEqual([{ kind: 'extra', path: 'scratch.ts' }])
  })

  test('a manifest target absent from the listing fails with missing-target, named by path', () => {
    const paths = parsePackedPaths(happyListing)
    expect(evaluatePackedPaths(paths, hostedRuling, ['src/web/mcp.ts'])).toEqual([
      { kind: 'missing-target', path: 'src/web/mcp.ts' },
    ])
  })
})

describe('packedTargetsFromManifest', () => {
  test('the real postgres-store manifest shape yields its five src/ targets exactly once each', () => {
    const manifest = {
      exports: {
        '.': { types: './src/index.ts', import: './src/index.ts' },
        './env': { types: './src/env.ts', import: './src/env.ts' },
        './schema': { types: './src/schema.ts', import: './src/schema.ts' },
        './store': { types: './src/store.ts', import: './src/store.ts' },
      },
      bin: { 'ab-postgres-store': './src/bin.ts' },
    }
    expect(packedTargetsFromManifest(manifest)).toEqual([
      'src/index.ts',
      'src/env.ts',
      'src/schema.ts',
      'src/store.ts',
      'src/bin.ts',
    ])
  })

  test('nested condition objects recurse to their string leaves', () => {
    const manifest = {
      exports: {
        '.': {
          import: { node: './src/a.ts', default: './src/b.ts' },
        },
      },
    }
    expect(packedTargetsFromManifest(manifest)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('a bare-string export value resolves to its package-relative path', () => {
    expect(packedTargetsFromManifest({ exports: { './env': './src/env.ts' } })).toEqual([
      'src/env.ts',
    ])
  })

  test("only './'-prefixed export strings are targets, and bin values are taken as paths", () => {
    const manifest = {
      exports: { '.': 'src/index.ts', './ok': './src/ok.ts', './external': 'other-package/x' },
      bin: { 'ab-postgres-store': 'src/bin.ts' },
    }
    expect(packedTargetsFromManifest(manifest)).toEqual(['src/ok.ts', 'src/bin.ts'])
  })

  test('non-string leaves are ignored, not treated as targets', () => {
    expect(packedTargetsFromManifest({ exports: { '.': { types: 42, import: null } } })).toEqual([])
  })
})

function listingFor(paths: readonly string[]): string {
  return [
    'bun pack v1.4.0 (34cbb9a40)',
    '',
    ...paths.map((path) => `packed 1KB ${path}`),
    '',
    `Total files: ${paths.length}`,
    'Unpacked size: 0.1MB',
    '',
  ].join('\n')
}

const hostedConformListing = listingFor([
  'package.json',
  'README.md',
  'src/bin.ts',
  'src/index.ts',
  'src/operator-api.ts',
  'src/remote-tickets.ts',
  'src/service.ts',
  'src/web/auth.ts',
  'src/web/config.ts',
  'src/web/mcp.ts',
  'src/web/runtime.ts',
])

const postgresConformListing = listingFor([
  'package.json',
  'README.md',
  'src/bin.ts',
  'src/env.ts',
  'src/index.ts',
  'src/schema.ts',
  'src/store.ts',
])

const dispatcherConformPaths = [
  'package.json',
  'README.md',
  'src/bin.ts',
  'src/dispatcher.ts',
  'src/index.ts',
  'src/runtime.ts',
  'src/ship-packed-distribution.ts',
]

const dispatcherConformListing = listingFor(dispatcherConformPaths)

/** A stray top-level file riding into the dispatcher tarball. */
const dispatcherLeakedListing = listingFor([...dispatcherConformPaths, 'scratch.ts'])

const rootConformListing = listingFor(rootConformPaths)

interface CapturedOutput {
  stdout: string[]
  stderr: string[]
}

function capture(): { output: PublishContentsCheckOutput; captured: CapturedOutput } {
  const captured: CapturedOutput = { stdout: [], stderr: [] }
  return {
    captured,
    output: {
      stdout: (message) => captured.stdout.push(message),
      stderr: (message) => captured.stderr.push(message),
    },
  }
}

const repositoryRoot = '/repo'

const rootDirectory = '.'
const dispatcherDirectory = 'packages/hosted-dispatcher'
const hostedDirectory = 'packages/hosted-store-service'
const postgresDirectory = 'packages/postgres-store'

interface FakePackage {
  directory: string
  listing?: string
  packResult?: Partial<PackResult>
  throwOnPack?: boolean
}

function fakeEnvironment(
  packages: readonly FakePackage[],
  manifests: readonly { path: string; text: string }[] = fakeWorkspaceManifests(),
): { environment: PublishContentsCheckEnvironment; requests: PackRequest[] } {
  const requests: PackRequest[] = []
  const runner: PackRunner = async (request: PackRequest): Promise<PackResult> => {
    requests.push(request)
    const fake = packages.find((entry) => join(repositoryRoot, entry.directory) === request.cwd)
    if (fake === undefined || fake.throwOnPack === true) throw new Error('spawn failed')
    return { exitCode: 0, stdout: fake.listing ?? '', stderr: '', ...fake.packResult }
  }
  return {
    requests,
    environment: {
      repositoryRoot,
      pack: runner,
      readManifests: async () => manifests,
    },
  }
}

function conformingPackages(): FakePackage[] {
  return [
    { directory: rootDirectory, listing: rootConformListing },
    { directory: dispatcherDirectory, listing: dispatcherConformListing },
    { directory: hostedDirectory, listing: hostedConformListing },
    { directory: postgresDirectory, listing: postgresConformListing },
  ]
}

describe('runPublishContentsCheck', () => {
  test('every publishable package conforming passes, packs all four directories, and reports each', async () => {
    const { output, captured } = capture()
    const { environment, requests } = fakeEnvironment(conformingPackages())
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(0)
    const stdout = captured.stdout.join('')
    expect(stdout).toContain(
      '@defrex/autobuild pack contents match the ruling: package.json, README.md, and 11 allowlisted file(s).',
    )
    expect(stdout).toContain(
      '@defrex/autobuild-hosted-dispatcher pack contents match the ruling: package.json, README.md, and 5 src/ file(s).',
    )
    expect(stdout).toContain(
      '@defrex/autobuild-hosted-store-service pack contents match the ruling: package.json, README.md, and 9 src/ file(s).',
    )
    expect(stdout).toContain(
      '@defrex/autobuild-postgres-store pack contents match the ruling: package.json, README.md, and 5 src/ file(s).',
    )
    // The success message must terminate its line like the failure paths do,
    // so terminal output stops concatenating with the next shell output.
    expect(stdout.endsWith('\n')).toBe(true)
    // Publish order: root first, then the dependency chain.
    expect(requests.map((request) => request.cwd)).toEqual([
      repositoryRoot,
      `${repositoryRoot}/${postgresDirectory}`,
      `${repositoryRoot}/${hostedDirectory}`,
      `${repositoryRoot}/${dispatcherDirectory}`,
    ])
    for (const request of requests) {
      expect(request.command).toBe('bun')
      expect(request.args).toEqual(['pm', 'pack', '--ignore-scripts', '--dry-run'])
    }
  })

  test('a stray top-level file in the dispatcher listing fails, naming the package and the path, while every other package is still evaluated', async () => {
    const { output, captured } = capture()
    const packages = conformingPackages().map((fake) =>
      fake.directory === dispatcherDirectory ? { ...fake, listing: dispatcherLeakedListing } : fake,
    )
    const { environment } = fakeEnvironment(packages)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    const stdout = captured.stdout.join('')
    expect(stdout).toContain('scratch.ts')
    expect(stdout).toContain('only package.json, README.md, and src/** are allowed by the ruling')
    expect(captured.stderr.join('')).toContain(
      'packed-contents violation(s) against the @defrex/autobuild-hosted-dispatcher tarball ruling',
    )
    // One failing package never hides another: the rest still pass.
    expect(stdout).toContain('@defrex/autobuild pack contents match the ruling')
    expect(stdout).toContain('@defrex/autobuild-postgres-store pack contents match the ruling')
    expect(stdout).toContain(
      '@defrex/autobuild-hosted-store-service pack contents match the ruling',
    )
  })

  test('a test file under packages/core/src in the root listing fails, naming the path', async () => {
    const { output, captured } = capture()
    const packages = conformingPackages().map((fake) =>
      fake.directory === rootDirectory
        ? {
            ...fake,
            listing: listingFor([...rootConformPaths, 'packages/core/src/cli/args.test.ts']),
          }
        : fake,
    )
    const { environment } = fakeEnvironment(packages)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stdout.join('')).toContain('packages/core/src/cli/args.test.ts')
    expect(captured.stderr.join('')).toContain(
      'packed-contents violation(s) against the @defrex/autobuild tarball ruling',
    )
  })

  test('a top-level file leaking into the postgres tarball fails with the AUT-473 ruling text', async () => {
    const { output, captured } = capture()
    const packages = conformingPackages().map((fake) =>
      fake.directory === postgresDirectory ? { ...fake, listing: postgresLeakedListing } : fake,
    )
    const { environment } = fakeEnvironment(packages)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    const combined = captured.stdout.join('')
    expect(combined).toContain('Ruling (AUT-473)')
    expect(combined).toContain('scratch.ts')
    expect(captured.stderr.join('')).toContain(
      'violation(s) against the @defrex/autobuild-postgres-store tarball ruling',
    )
    expect(captured.stderr.join('').endsWith('\n')).toBe(true)
  })

  test('a hosted leak still evaluates the other packages and keeps the AUT-463 ruling text', async () => {
    const { output, captured } = capture()
    const packages = conformingPackages().map((fake) =>
      fake.directory === hostedDirectory ? { ...fake, listing: leakedListing } : fake,
    )
    const { environment } = fakeEnvironment(packages)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    const combined = captured.stdout.join('')
    expect(combined).toContain('Ruling (AUT-463)')
    expect(combined).toContain('.impeccable/surfaces/app-dashboard-dashboardclient-tsx.md')
    expect(combined).toContain('server.ts')
    expect(combined).toContain('@defrex/autobuild-postgres-store pack contents match the ruling')
    expect(captured.stderr.join('')).toContain(
      'packed-contents violation(s) against the @defrex/autobuild-hosted-store-service tarball ruling',
    )
  })

  test('a failing pack on one package is a failed check that names it, not a pass', async () => {
    const { output, captured } = capture()
    const packages = conformingPackages().map((fake) =>
      fake.directory === postgresDirectory
        ? { ...fake, packResult: { exitCode: 1, stderr: 'no such package' } }
        : fake,
    )
    const { environment } = fakeEnvironment(packages)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain(
      `bun pm pack --ignore-scripts --dry-run failed in ${repositoryRoot}/${postgresDirectory}`,
    )
    expect(captured.stderr.join('')).toContain('no such package')
  })

  test('a thrown runner is a failed check (fail-closed, like every check here)', async () => {
    const { output, captured } = capture()
    const packages = conformingPackages().map((fake) =>
      fake.directory === hostedDirectory ? { ...fake, throwOnPack: true } : fake,
    )
    const { environment } = fakeEnvironment(packages)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain(
      'Could not check the @defrex/autobuild-hosted-store-service pack contents',
    )
    expect(captured.stderr.join('')).toContain('spawn failed')
    // The other ruled packages are still checked.
    expect(captured.stdout.join('')).toContain(
      '@defrex/autobuild-postgres-store pack contents match',
    )
  })

  test('a manifest with no files allowlist fails with no-files-allowlist and skips the listing evaluation', async () => {
    const { output, captured } = capture()
    const noFiles = JSON.stringify({
      name: '@defrex/autobuild-postgres-store',
      version: '0.8.0',
      peerDependencies: { '@defrex/autobuild': '>=0.7.0' },
      exports: { '.': './src/index.ts' },
      bin: { 'ab-postgres-store': './src/bin.ts' },
    })
    const manifests = fakeWorkspaceManifests().map((entry) =>
      entry.path === 'packages/postgres-store/package.json' ? { ...entry, text: noFiles } : entry,
    )
    const { environment, requests } = fakeEnvironment(conformingPackages(), manifests)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    const combined = captured.stdout.join('')
    expect(combined).toContain('Ruling (AUT-473)')
    expect(combined).toContain('no non-empty `files` allowlist')
    expect(captured.stderr.join('')).toContain('1 packed-contents violation(s)')
    // No ruling can be derived, so the package is not packed at all.
    expect(
      requests.some((request) => request.cwd === `${repositoryRoot}/${postgresDirectory}`),
    ).toBe(false)
  })

  test('an empty files array is no allowlist either', async () => {
    const { output, captured } = capture()
    const emptyFiles = JSON.stringify({
      name: '@defrex/autobuild-postgres-store',
      version: '0.8.0',
      files: [],
      exports: { '.': './src/index.ts' },
      bin: { 'ab-postgres-store': './src/bin.ts' },
    })
    const manifests = fakeWorkspaceManifests().map((entry) =>
      entry.path === 'packages/postgres-store/package.json'
        ? { ...entry, text: emptyFiles }
        : entry,
    )
    const { environment } = fakeEnvironment(conformingPackages(), manifests)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stdout.join('')).toContain('no non-empty `files` allowlist')
  })

  test('an empty listing for a ruled package fails as empty-listing, never as a pass', async () => {
    const { output, captured } = capture()
    const packages = conformingPackages().map((fake) =>
      fake.directory === postgresDirectory ? { ...fake, listing: '' } : fake,
    )
    const { environment } = fakeEnvironment(packages)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stdout.join('')).toContain('no `packed <size> <path>` lines')
  })

  test('an exports target missing from the listing fails, naming the path', async () => {
    const { output, captured } = capture()
    const listingWithoutEnv = listingFor([
      'package.json',
      'README.md',
      'src/bin.ts',
      'src/index.ts',
      'src/schema.ts',
      'src/store.ts',
    ])
    const packages = conformingPackages().map((fake) =>
      fake.directory === postgresDirectory ? { ...fake, listing: listingWithoutEnv } : fake,
    )
    const { environment } = fakeEnvironment(packages)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    const combined = captured.stdout.join('')
    expect(combined).toContain('src/env.ts is an exports/bin target in the manifest')
    expect(combined).toContain('missing from the tarball')
  })

  test('an unparseable manifest is a failed enumeration, not a pass', async () => {
    const { output, captured } = capture()
    const manifests = fakeWorkspaceManifests().map((entry) =>
      entry.path === 'packages/postgres-store/package.json'
        ? { ...entry, text: '{not json' }
        : entry,
    )
    const { environment, requests } = fakeEnvironment(conformingPackages(), manifests)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain(
      "Could not check the publishable packages' pack contents",
    )
    expect(captured.stderr.join('')).toContain('packages/postgres-store/package.json')
    expect(captured.stderr.join('')).toContain('invalid package manifest')
    // Fail closed before any pack: nothing is packed, nothing passes.
    expect(requests).toEqual([])
  })

  test('a thrown readManifests exits 1 with a stderr message, never a pass', async () => {
    const { output, captured } = capture()
    const requests: PackRequest[] = []
    const environment: PublishContentsCheckEnvironment = {
      repositoryRoot,
      pack: async (request) => {
        requests.push(request)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      readManifests: async () => {
        throw new Error('workspace manifests unreadable')
      },
    }
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain(
      "Could not check the publishable packages' pack contents",
    )
    expect(captured.stderr.join('')).toContain('workspace manifests unreadable')
    expect(requests).toEqual([])
  })

  test('a non-string files entry fails the whole check, naming the manifest', async () => {
    const { output, captured } = capture()
    const badFiles = JSON.stringify({
      name: '@defrex/autobuild-postgres-store',
      version: '0.8.0',
      files: ['src', 42],
      exports: { '.': './src/index.ts' },
      bin: { 'ab-postgres-store': './src/bin.ts' },
    })
    const manifests = fakeWorkspaceManifests().map((entry) =>
      entry.path === 'packages/postgres-store/package.json' ? { ...entry, text: badFiles } : entry,
    )
    const { environment } = fakeEnvironment(conformingPackages(), manifests)
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain('packages/postgres-store/package.json')
    expect(captured.stderr.join('')).toContain("every 'files' entry must be a string")
  })
})
