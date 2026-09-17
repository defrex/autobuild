import { describe, expect, test } from 'bun:test'
import {
  type PackRequest,
  type PackResult,
  type PackRunner,
  type PublishContentsCheckEnvironment,
  type PublishContentsCheckOutput,
  type TarballRuling,
  evaluatePackedPaths,
  packedTargetsFromManifest,
  parsePackedPaths,
  ruledPackages,
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

const hostedRuling: TarballRuling = ruledPackages.find(
  (ruling) => ruling.directory === 'packages/hosted-store-service',
)!
const postgresRuling: TarballRuling = ruledPackages.find(
  (ruling) => ruling.directory === 'packages/postgres-store',
)!

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

  test('a listing missing src/ fails with missing-src, not silently', () => {
    const violations = evaluatePackedPaths(['package.json', 'README.md'], postgresRuling)
    expect(violations).toEqual([{ kind: 'missing-src' }])
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

/** The real postgres-store manifest shape, as JSON text, for the runner seam. */
const postgresManifestText = JSON.stringify({
  name: '@defrex/autobuild-postgres-store',
  files: ['src', 'README.md'],
  exports: {
    '.': { types: './src/index.ts', import: './src/index.ts' },
    './env': { types: './src/env.ts', import: './src/env.ts' },
    './schema': { types: './src/schema.ts', import: './src/schema.ts' },
    './store': { types: './src/store.ts', import: './src/store.ts' },
  },
  bin: { 'ab-postgres-store': './src/bin.ts' },
})

/** The real hosted-store-service manifest shape (subpaths abbreviated), as JSON text. */
const hostedManifestText = JSON.stringify({
  name: '@defrex/autobuild-hosted-store-service',
  files: ['src', 'README.md'],
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
const hostedDirectory = 'packages/hosted-store-service'
const postgresDirectory = 'packages/postgres-store'

interface FakePackage {
  directory: string
  manifest: string
  listing?: string
  packResult?: Partial<PackResult>
  throwOnPack?: boolean
}

function fakeEnvironment(packages: readonly FakePackage[]): {
  environment: PublishContentsCheckEnvironment
  requests: PackRequest[]
} {
  const requests: PackRequest[] = []
  const runner: PackRunner = async (request: PackRequest): Promise<PackResult> => {
    requests.push(request)
    const fake = packages.find((entry) => `${repositoryRoot}/${entry.directory}` === request.cwd)
    if (fake === undefined || fake.throwOnPack === true) throw new Error('spawn failed')
    return { exitCode: 0, stdout: fake.listing ?? '', stderr: '', ...fake.packResult }
  }
  return {
    requests,
    environment: {
      repositoryRoot,
      pack: runner,
      readManifest: async (directory) => {
        const fake = packages.find((entry) => entry.directory === directory)
        if (fake === undefined) throw new Error(`no fixture manifest for ${directory}`)
        return fake.manifest
      },
    },
  }
}

describe('runPublishContentsCheck', () => {
  test('both ruled packages conforming passes, checks both directories, and reports both counts', async () => {
    const { output, captured } = capture()
    const { environment, requests } = fakeEnvironment([
      { directory: hostedDirectory, manifest: hostedManifestText, listing: hostedConformListing },
      {
        directory: postgresDirectory,
        manifest: postgresManifestText,
        listing: postgresConformListing,
      },
    ])
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(0)
    const stdout = captured.stdout.join('')
    expect(stdout).toContain(
      '@defrex/autobuild-hosted-store-service pack contents match the ruling',
    )
    expect(stdout).toContain('@defrex/autobuild-postgres-store pack contents match the ruling')
    // The success message must terminate its line like the failure paths do,
    // so terminal output stops concatenating with the next shell output.
    expect(stdout.endsWith('\n')).toBe(true)
    expect(requests.map((request) => request.cwd)).toEqual([
      `${repositoryRoot}/${hostedDirectory}`,
      `${repositoryRoot}/${postgresDirectory}`,
    ])
    for (const request of requests) {
      expect(request.command).toBe('bun')
      expect(request.args).toEqual(['pm', 'pack', '--dry-run'])
    }
  })

  test('a top-level file leaking into the postgres tarball fails with the AUT-473 ruling text', async () => {
    const { output, captured } = capture()
    const { environment } = fakeEnvironment([
      { directory: hostedDirectory, manifest: hostedManifestText, listing: hostedConformListing },
      {
        directory: postgresDirectory,
        manifest: postgresManifestText,
        listing: postgresLeakedListing,
      },
    ])
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

  test('one failing package does not hide another: a hosted leak still evaluates postgres-store', async () => {
    const { output, captured } = capture()
    const { environment } = fakeEnvironment([
      { directory: hostedDirectory, manifest: hostedManifestText, listing: leakedListing },
      {
        directory: postgresDirectory,
        manifest: postgresManifestText,
        listing: postgresConformListing,
      },
    ])
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
    const { environment } = fakeEnvironment([
      { directory: hostedDirectory, manifest: hostedManifestText, listing: hostedConformListing },
      {
        directory: postgresDirectory,
        manifest: postgresManifestText,
        packResult: { exitCode: 1, stderr: 'no such package' },
      },
    ])
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain(
      `bun pm pack --dry-run failed in ${repositoryRoot}/${postgresDirectory}`,
    )
    expect(captured.stderr.join('')).toContain('no such package')
  })

  test('a thrown runner is a failed check (fail-closed, like every check here)', async () => {
    const { output, captured } = capture()
    const { environment } = fakeEnvironment([
      { directory: hostedDirectory, manifest: hostedManifestText, throwOnPack: true },
      {
        directory: postgresDirectory,
        manifest: postgresManifestText,
        listing: postgresConformListing,
      },
    ])
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain(
      'Could not check the @defrex/autobuild-hosted-store-service pack contents',
    )
    expect(captured.stderr.join('')).toContain('spawn failed')
    // The other ruled package is still checked.
    expect(captured.stdout.join('')).toContain(
      '@defrex/autobuild-postgres-store pack contents match',
    )
  })

  test('a manifest with no files allowlist fails with no-files-allowlist', async () => {
    const { output, captured } = capture()
    const noFiles = JSON.stringify({
      name: '@defrex/autobuild-postgres-store',
      exports: { '.': './src/index.ts' },
      bin: { 'ab-postgres-store': './src/bin.ts' },
    })
    const { environment } = fakeEnvironment([
      { directory: postgresDirectory, manifest: noFiles, listing: postgresConformListing },
      { directory: hostedDirectory, manifest: hostedManifestText, listing: hostedConformListing },
    ])
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    const combined = captured.stdout.join('')
    expect(combined).toContain('Ruling (AUT-473)')
    expect(combined).toContain('no non-empty `files` allowlist')
    expect(captured.stderr.join('')).toContain('1 packed-contents violation(s)')
  })

  test('an empty files array is no allowlist either', async () => {
    const { output, captured } = capture()
    const emptyFiles = JSON.stringify({
      name: '@defrex/autobuild-postgres-store',
      files: [],
      exports: { '.': './src/index.ts' },
      bin: { 'ab-postgres-store': './src/bin.ts' },
    })
    const { environment } = fakeEnvironment([
      { directory: postgresDirectory, manifest: emptyFiles, listing: postgresConformListing },
      { directory: hostedDirectory, manifest: hostedManifestText, listing: hostedConformListing },
    ])
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stdout.join('')).toContain('no non-empty `files` allowlist')
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
    const { environment } = fakeEnvironment([
      { directory: hostedDirectory, manifest: hostedManifestText, listing: hostedConformListing },
      { directory: postgresDirectory, manifest: postgresManifestText, listing: listingWithoutEnv },
    ])
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    const combined = captured.stdout.join('')
    expect(combined).toContain('src/env.ts is an exports/bin target in the manifest')
    expect(combined).toContain('missing from the tarball')
  })

  test('an unparseable manifest is a failed check, not a pass', async () => {
    const { output, captured } = capture()
    const { environment } = fakeEnvironment([
      { directory: hostedDirectory, manifest: hostedManifestText, listing: hostedConformListing },
      { directory: postgresDirectory, manifest: '{not json', listing: postgresConformListing },
    ])
    const exitCode = await runPublishContentsCheck(environment, output)
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain(
      'Could not check the @defrex/autobuild-postgres-store pack contents',
    )
    expect(captured.stderr.join('')).toContain('invalid package manifest')
  })
})
