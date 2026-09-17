import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  type PublishImportsCheckEnvironment,
  type PublishImportsReport,
  exportsSubpaths,
  exportsTargets,
  isProviderSpecifier,
  packedScriptKind,
  runPublishImportsCheck,
  scanPublishedImports,
  subpathOfProviderSpecifier,
} from './publish-imports-check'
import ts from 'typescript'

/**
 * Fixture strategy: a real on-disk mini-repo (manifests and sources written to
 * a temp root) with every expensive seam injected — the pack runner returns a
 * canned bun-shaped listing per package directory, while file reading, staging,
 * scratch creation, and module resolution run for real against the fixture and
 * a real scratch `node_modules` layout. The staging-fidelity and skew cases
 * therefore exercise the same `Bun.resolveSync` exports-map algorithm the
 * hermetic guard relies on, without spawning a single `bun pm pack`.
 */

interface FixtureSpec {
  /** Repo-root-relative package directory ('.' for the root/provider). */
  directory: string
  manifest: Record<string, unknown>
  /** Repo-root-relative worktree files. */
  files?: Record<string, string>
  /** Overrides the packed listing (defaults to package.json + files). */
  packedPaths?: readonly string[]
}

const createdRoots: string[] = []

async function buildFixtureRepo(specs: readonly FixtureSpec[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'publish-imports-fixture-'))
  createdRoots.push(root)
  for (const spec of specs) {
    const directory = join(root, spec.directory)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify(spec.manifest))
    for (const [path, contents] of Object.entries(spec.files ?? {})) {
      const absolute = join(root, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, contents)
    }
  }
  return root
}

function fixtureEnvironment(
  root: string,
  specs: readonly FixtureSpec[],
): PublishImportsCheckEnvironment {
  return {
    repoRoot: root,
    pack: async (request) => {
      const spec = specs.find(
        (candidate) => resolve(join(root, candidate.directory)) === resolve(request.cwd),
      )
      if (spec === undefined) {
        return { exitCode: 1, stdout: '', stderr: `no fixture package at ${request.cwd}` }
      }
      // Packed paths are relative to the package directory, like real bun
      // output; the fixture's file keys are repo-root-relative.
      const directoryRoot = resolve(join(root, spec.directory))
      const paths = spec.packedPaths ?? [
        'package.json',
        ...Object.keys(spec.files ?? {}).map((path) => relative(directoryRoot, join(root, path))),
      ]
      const listing = ['bun pack v1.4.0', '', ...paths.map((path) => `packed 1B ${path}`), ''].join(
        '\n',
      )
      return { exitCode: 0, stdout: listing, stderr: '' }
    },
    readFile: (path) => readFile(path),
    stage: async (source, destination) => {
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    },
    resolveModule: (specifier, fromPath) => Bun.resolveSync(specifier, fromPath),
    createScratchRoot: () => mkdtemp(join(tmpdir(), 'publish-imports-scratch-')),
    removeScratchRoot: (scratch) => rm(scratch, { recursive: true, force: true }),
  }
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

const PROVIDER = '@defrex/autobuild'
const SERVICE = '@defrex/autobuild-hosted-store-service'
const POSTGRES = '@defrex/autobuild-postgres-store'

/** Root provider manifest: workspaces plus an exports map the tests shape. */
function providerManifest(exports: Record<string, unknown>): Record<string, unknown> {
  return {
    name: PROVIDER,
    version: '0.9.0',
    type: 'module',
    workspaces: ['packages/*'],
    exports,
  }
}

const operatorTarget = './core-src/operator/index.ts'
// Single condition per key keeps the fixture probes to one target each; the
// real root manifest carries types/import/default, which the guard probes
// (and dedupes identical target findings for) just the same.
const operatorExports = {
  './operator': { import: operatorTarget },
}
const OPERATOR_SOURCE = 'export const operator = true\n'

const dependentManifest = {
  name: SERVICE,
  version: '0.9.0',
  type: 'module',
  exports: { '.': { types: './src/index.ts', import: './src/index.ts' } },
}

const postgresManifest = {
  name: POSTGRES,
  version: '0.9.0',
  type: 'module',
  exports: { '.': { types: './src/index.ts', import: './src/index.ts' } },
}

/** The pass-case fixture: provider exports ./operator, dependent imports it. */
async function passFixture(): Promise<{ root: string; env: PublishImportsCheckEnvironment }> {
  const specs: FixtureSpec[] = [
    {
      directory: '.',
      manifest: providerManifest(operatorExports),
      files: { 'core-src/operator/index.ts': OPERATOR_SOURCE },
    },
    {
      directory: 'packages/store-service',
      manifest: dependentManifest,
      files: {
        'packages/store-service/src/index.ts':
          "import { operator } from '@defrex/autobuild/operator'\nexport { operator }\n",
      },
    },
    {
      directory: 'packages/postgres-store',
      manifest: postgresManifest,
      files: {
        'packages/postgres-store/src/index.ts':
          "import { operator } from '@defrex/autobuild/operator'\n",
      },
    },
  ]
  const root = await buildFixtureRepo(specs)
  return { root, env: fixtureEnvironment(root, specs) }
}

describe('isProviderSpecifier / subpathOfProviderSpecifier', () => {
  test('the bare provider name and its subpaths qualify', () => {
    expect(isProviderSpecifier(PROVIDER)).toBe(true)
    expect(isProviderSpecifier(`${PROVIDER}/operator`)).toBe(true)
    expect(isProviderSpecifier(`${PROVIDER}/web/auth`)).toBe(true)
  })

  test('sibling package names sharing the prefix are never provider specifiers', () => {
    expect(isProviderSpecifier(`${SERVICE}/service`)).toBe(false)
    expect(isProviderSpecifier(`${SERVICE}`)).toBe(false)
    expect(isProviderSpecifier(`${POSTGRES}/env`)).toBe(false)
    expect(isProviderSpecifier('@defrex/autobuild-hosted-dispatcher/runtime')).toBe(false)
    expect(isProviderSpecifier('./relative')).toBe(false)
    expect(isProviderSpecifier('other-package')).toBe(false)
  })

  test('subpath mapping: bare name to ".", subpath to "./<sub>"', () => {
    expect(subpathOfProviderSpecifier(PROVIDER)).toBe('.')
    expect(subpathOfProviderSpecifier(`${PROVIDER}/operator`)).toBe('./operator')
    expect(subpathOfProviderSpecifier(`${PROVIDER}/web/auth`)).toBe('./web/auth')
  })
})

describe('exportsTargets / exportsSubpaths', () => {
  test('collects string leaves from conditions objects and bare strings', () => {
    expect(exportsTargets('./src/index.ts')).toEqual(['./src/index.ts'])
    expect(
      exportsTargets({
        types: './src/index.ts',
        import: './src/index.ts',
        default: null,
        nested: { node: './src/node.ts' },
      }),
    ).toEqual(['./src/index.ts', './src/index.ts', './src/node.ts'])
  })

  test('a manifest without exports yields an empty map (fail-closed for the guard)', () => {
    expect(exportsSubpaths({ name: 'x' }).size).toBe(0)
  })
})

describe('scanPublishedImports', () => {
  test('pass case: an exported subpath resolves from the staged tarball layout', async () => {
    const { env } = await passFixture()
    const report: PublishImportsReport = await scanPublishedImports(env)
    expect(report.violations).toEqual([])
    expect(report.packedPackages).toBe(3)
    expect(report.scannedFiles).toBe(2)
    expect(report.probedSpecifiers).toBe(2)
  })

  test('the pack seam is bun pm pack --ignore-scripts --dry-run in the package directory', async () => {
    const requests: { command: string; args: readonly string[]; cwd: string }[] = []
    const { env } = await passFixture()
    const probing: PublishImportsCheckEnvironment = {
      ...env,
      pack: async (request) => {
        requests.push(request)
        return env.pack(request)
      },
    }
    await scanPublishedImports(probing)
    expect(requests.map((request) => request.args)).toEqual([
      ['pm', 'pack', '--ignore-scripts', '--dry-run'],
      ['pm', 'pack', '--ignore-scripts', '--dry-run'],
      ['pm', 'pack', '--ignore-scripts', '--dry-run'],
    ])
  })

  test('the 0.8.0 skew shape: subpaths the published provider lacks are named with their exports keys', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './operator-api': {
            types: './core-src/operator-api.ts',
            import: './core-src/operator-api.ts',
          },
        }),
        files: { 'core-src/operator-api.ts': 'export const api = true\n' },
      },
      {
        directory: 'packages/store-service',
        manifest: dependentManifest,
        files: {
          'packages/store-service/src/index.ts':
            "import { operator } from '@defrex/autobuild/operator'\nimport { tickets } from '@defrex/autobuild/testing'\n",
        },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(
      report.violations.map((violation) => ({
        kind: violation.kind,
        specifier: violation.kind === 'missing-export' ? violation.specifier : '',
        subpath: violation.kind === 'missing-export' ? violation.subpath : '',
      })),
    ).toEqual([
      { kind: 'missing-export', specifier: `${PROVIDER}/operator`, subpath: './operator' },
      { kind: 'missing-export', specifier: `${PROVIDER}/testing`, subpath: './testing' },
    ])
  })

  test('staging fidelity: a target present in the worktree but absent from the packed listing is a resolution violation', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest(operatorExports),
        files: { 'core-src/operator/index.ts': OPERATOR_SOURCE },
        // The tarball omits the file even though the worktree has it.
        packedPaths: ['package.json'],
      },
      {
        directory: 'packages/store-service',
        manifest: dependentManifest,
        files: {
          'packages/store-service/src/index.ts': "import '@defrex/autobuild/operator'\n",
        },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    // The provider's './operator' target is also absent from its own packed
    // listing, so the integrity probe flags it and the dependent's import
    // fails resolution from the staged layout — two findings, one root cause.
    expect(report.violations).toHaveLength(2)
    const violation = report.violations.find((candidate) => candidate.kind === 'unresolved-import')
    expect(violation?.kind).toBe('unresolved-import')
    if (violation?.kind === 'unresolved-import') {
      expect(violation.specifier).toBe(`${PROVIDER}/operator`)
      expect(violation.reason).toContain('Cannot find')
    }
    expect(report.violations.some((entry) => entry.kind === 'unresolved-exports-target')).toBe(true)
  })

  test('an exports target missing from the packed listing is a violation, for either side', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          ...operatorExports,
          './testing': { import: './core-src/testing/index.ts' },
        }),
        // testing/index.ts exists in the worktree but is not packed.
        files: {
          'core-src/operator/index.ts': OPERATOR_SOURCE,
          'core-src/testing/index.ts': 'export const testing = true\n',
        },
        packedPaths: ['package.json', 'core-src/operator/index.ts'],
      },
      {
        directory: 'packages/store-service',
        manifest: {
          ...dependentManifest,
          exports: { './ghost': { import: './src/ghost.ts' } },
        },
        files: {
          'packages/store-service/src/index.ts': 'export {}\n',
          'packages/store-service/src/ghost.ts': 'export const ghost = true\n',
        },
        packedPaths: ['package.json', 'src/index.ts'],
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(
      report.violations.map((violation) =>
        violation.kind === 'unresolved-exports-target'
          ? { kind: violation.kind, packageName: violation.packageName, target: violation.target }
          : violation.kind,
      ),
    ).toEqual([
      {
        kind: 'unresolved-exports-target',
        packageName: PROVIDER,
        target: './testing → ./core-src/testing/index.ts',
      },
      {
        kind: 'unresolved-exports-target',
        packageName: SERVICE,
        target: './ghost → ./src/ghost.ts',
      },
    ])
  })

  test('scanner coverage: every import position is collected, comment and template text never', async () => {
    const source = [
      "import { operator } from '@defrex/autobuild/operator'",
      "export { operator } from '@defrex/autobuild/operator'",
      "export type { Operator } from '@defrex/autobuild/operator'",
      "import type { Operator } from '@defrex/autobuild/operator'",
      "export const load = () => import('@defrex/autobuild/operator')",
      "export type Load = typeof import('@defrex/autobuild/operator')",
      "type Mod = import('@defrex/autobuild/operator').OperatorModule",
      '// a comment naming @defrex/autobuild/testing is not an import',
      'const note = `template interior @defrex/autobuild/testing is not an import`',
      "const sibling = () => import('@defrex/autobuild-hosted-store-service/service')",
    ].join('\n')
    const specs: FixtureSpec[] = [
      { directory: '.', manifest: providerManifest({}) },
      {
        directory: 'packages/store-service',
        manifest: dependentManifest,
        files: { 'packages/store-service/src/index.ts': source },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    const specifiers = report.violations.map((violation) =>
      violation.kind === 'missing-export' ? violation.specifier : '',
    )
    // Every real import position is collected (seven of them); the comment, the
    // template interior, and the sibling-package specifier are not.
    expect(specifiers.sort()).toEqual([
      `${PROVIDER}/operator`, // static import
      `${PROVIDER}/operator`, // export … from
      `${PROVIDER}/operator`, // export type … from
      `${PROVIDER}/operator`, // import type
      `${PROVIDER}/operator`, // dynamic import('…')
      `${PROVIDER}/operator`, // typeof import('…')
      `${PROVIDER}/operator`, // import('…').Type
    ])
    expect(specifiers.includes(`${PROVIDER}/testing`)).toBe(false)
  })

  test('name filter: sibling @defrex/autobuild-* specifiers are not provider imports and are not probed', async () => {
    const source = [
      "import { service } from '@defrex/autobuild-hosted-store-service/service'",
      "import { env } from '@defrex/autobuild-postgres-store/env'",
      "import type { Dispatcher } from '@defrex/autobuild-hosted-dispatcher/dispatcher'",
    ].join('\n')
    const specs: FixtureSpec[] = [
      { directory: '.', manifest: providerManifest({}) },
      {
        directory: 'packages/store-service',
        manifest: dependentManifest,
        files: { 'packages/store-service/src/index.ts': source },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([])
    expect(report.probedSpecifiers).toBe(0)
  })

  test('an unparseable dependent file is a sentinel violation, never a silent pass', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest(operatorExports),
        files: { 'core-src/operator/index.ts': OPERATOR_SOURCE },
      },
      {
        directory: 'packages/store-service',
        manifest: dependentManifest,
        files: {
          'packages/store-service/src/index.ts': OPERATOR_SOURCE,
          'packages/store-service/src/broken.ts': 'this is definitely not typescript',
        },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([
      {
        kind: 'unparseable-file',
        packageName: SERVICE,
        path: 'packages/store-service/src/broken.ts',
      },
    ])
  })

  test('a dependent whose pack fails is a pack violation, not a silent pass', async () => {
    const { env } = await passFixture()
    const failing: PublishImportsCheckEnvironment = {
      ...env,
      pack: async (request) =>
        request.cwd.includes('store-service')
          ? { exitCode: 1, stdout: '', stderr: 'no such package' }
          : env.pack(request),
    }
    const report = await scanPublishedImports(failing)
    expect(report.violations).toEqual([
      { kind: 'pack', directory: 'packages/store-service', detail: 'no such package' },
    ])
  })

  test('a listing with no package.json entry fails closed as a pack violation', async () => {
    const { env } = await passFixture()
    const drifted: PublishImportsCheckEnvironment = {
      ...env,
      pack: async (request) =>
        request.cwd.includes('store-service')
          ? { exitCode: 0, stdout: 'bun pack v1.4.0\n\nno parseable lines\n', stderr: '' }
          : env.pack(request),
    }
    const report = await scanPublishedImports(drifted)
    expect(report.violations).toEqual([
      {
        kind: 'pack',
        directory: 'packages/store-service',
        detail: 'the pack listing has no package.json entry; the listing could not be parsed',
      },
    ])
  })

  test('a publish set without the provider throws structurally', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: { name: 'root-pkg', version: '0.1.0', workspaces: ['packages/*'] },
      },
      {
        directory: 'packages/store-service',
        manifest: dependentManifest,
        files: { 'packages/store-service/src/index.ts': 'export {}\n' },
      },
    ]
    const root = await buildFixtureRepo(specs)
    await expect(scanPublishedImports(fixtureEnvironment(root, specs))).rejects.toThrow(
      'exactly one',
    )
  })

  test('a failed provider pack throws structurally, failing the whole check', async () => {
    const { root, env } = await passFixture()
    const failing: PublishImportsCheckEnvironment = {
      ...env,
      pack: async (request) =>
        request.cwd === resolve(root)
          ? { exitCode: 1, stdout: '', stderr: 'registry exploded' }
          : env.pack(request),
    }
    await expect(scanPublishedImports(failing)).rejects.toThrow('failed in .')
  })
})

describe('packedScriptKind', () => {
  test('maps exactly the chosen TS/JS/JSX suffix set and nothing else', () => {
    expect(packedScriptKind('src/index.ts')).toBe(ts.ScriptKind.TS)
    expect(packedScriptKind('x.mts')).toBe(ts.ScriptKind.TS)
    expect(packedScriptKind('x.cts')).toBe(ts.ScriptKind.TS)
    expect(packedScriptKind('x.d.ts')).toBe(ts.ScriptKind.TS)
    expect(packedScriptKind('x.d.mts')).toBe(ts.ScriptKind.TS)
    expect(packedScriptKind('x.d.cts')).toBe(ts.ScriptKind.TS)
    expect(packedScriptKind('x.tsx')).toBe(ts.ScriptKind.TSX)
    expect(packedScriptKind('x.js')).toBe(ts.ScriptKind.JS)
    expect(packedScriptKind('x.mjs')).toBe(ts.ScriptKind.JS)
    expect(packedScriptKind('x.cjs')).toBe(ts.ScriptKind.JS)
    expect(packedScriptKind('x.jsx')).toBe(ts.ScriptKind.JSX)
    expect(packedScriptKind('x.json')).toBeUndefined()
    expect(packedScriptKind('README.md')).toBeUndefined()
    expect(packedScriptKind('src/x.d.ts.map')).toBeUndefined()
    expect(packedScriptKind('native.node')).toBeUndefined()
    expect(packedScriptKind('no-extension')).toBeUndefined()
    expect(packedScriptKind('LICENSE')).toBeUndefined()
  })

  test('matching is case-sensitive, like the \\.tsx?$ filter it replaced', () => {
    expect(packedScriptKind('x.JS')).toBeUndefined()
    expect(packedScriptKind('x.TS')).toBeUndefined()
    expect(packedScriptKind('x.Jsx')).toBeUndefined()
  })
})

describe('widened packed-file scan (AUT-479)', () => {
  test('a packed .js file importing an unexported subpath fails the guard and is counted as scanned', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest(operatorExports),
        files: { 'core-src/operator/index.ts': OPERATOR_SOURCE },
      },
      {
        directory: 'packages/store-service',
        manifest: {
          ...dependentManifest,
          exports: { '.': { types: './src/legacy.js', import: './src/legacy.js' } },
        },
        files: {
          'packages/store-service/src/legacy.js':
            "import '@defrex/autobuild/missing'\nexport const legacy = true\n",
        },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([
      {
        kind: 'missing-export',
        packageName: SERVICE,
        specifier: `${PROVIDER}/missing`,
        subpath: './missing',
        path: 'packages/store-service/src/legacy.js',
        line: 1,
      },
    ])
    // The JS file is counted, not silently skipped.
    expect(report.scannedFiles).toBe(1)
  })

  test('a packed .cjs require form fails the guard (ScriptKind.JS collects require-ish specifiers)', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest(operatorExports),
        files: { 'core-src/operator/index.ts': OPERATOR_SOURCE },
      },
      {
        directory: 'packages/store-service',
        manifest: {
          ...dependentManifest,
          exports: { '.': { default: './src/legacy.cjs' } },
        },
        files: {
          'packages/store-service/src/legacy.cjs':
            "const { testing } = require('@defrex/autobuild/testing')\nmodule.exports = { testing }\n",
        },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([
      {
        kind: 'missing-export',
        packageName: SERVICE,
        specifier: `${PROVIDER}/testing`,
        subpath: './testing',
        path: 'packages/store-service/src/legacy.cjs',
        line: 1,
      },
    ])
  })

  test('a packed .mts file no longer escapes the scan (it did under the \\.tsx?$ filter)', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest(operatorExports),
        files: { 'core-src/operator/index.ts': OPERATOR_SOURCE },
      },
      {
        directory: 'packages/store-service',
        manifest: {
          ...dependentManifest,
          exports: { '.': { import: './src/modern.mts' } },
        },
        files: {
          'packages/store-service/src/modern.mts':
            "import '@defrex/autobuild/missing'\nexport const modern = true\n",
        },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([
      {
        kind: 'missing-export',
        packageName: SERVICE,
        specifier: `${PROVIDER}/missing`,
        subpath: './missing',
        path: 'packages/store-service/src/modern.mts',
        line: 1,
      },
    ])
  })

  test('a packed .jsx file parses as JSX, not the unparseable sentinel, and its exported subpath is probed', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest(operatorExports),
        files: { 'core-src/operator/index.ts': OPERATOR_SOURCE },
      },
      {
        directory: 'packages/store-service',
        manifest: {
          ...dependentManifest,
          exports: { '.': { import: './src/component.jsx' } },
        },
        files: {
          'packages/store-service/src/component.jsx':
            "import { operator } from '@defrex/autobuild/operator'\nexport const component = () => <div>{operator}</div>\n",
        },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([])
    expect(report.scannedFiles).toBe(1)
    expect(report.probedSpecifiers).toBe(1)
  })

  test('packed non-script files are not scanned: no sentinel findings, no added scan count', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest(operatorExports),
        files: { 'core-src/operator/index.ts': OPERATOR_SOURCE },
      },
      {
        directory: 'packages/store-service',
        manifest: dependentManifest,
        files: {
          'packages/store-service/src/index.ts': 'export {}\n',
          // If any of these were scanned, each would fail closed as an
          // unparseable-file violation naming its provider specifier text.
          'packages/store-service/data.json': '{"imports": "@defrex/autobuild/testing"}',
          'packages/store-service/README.md': '# reads `@defrex/autobuild/testing`',
          'packages/store-service/src/index.d.ts.map':
            '{"sources": ["import \'@defrex/autobuild/testing\'"]}',
        },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([])
    // Only src/index.ts is scanned; the JSON, markdown, and source-map files
    // add nothing to the count.
    expect(report.scannedFiles).toBe(1)
  })
})

interface CapturedOutput {
  stdout: string[]
  stderr: string[]
}

function capture(): {
  output: import('./publish-imports-check').PublishImportsCheckOutput
  captured: CapturedOutput
} {
  const captured: CapturedOutput = { stdout: [], stderr: [] }
  return {
    captured,
    output: {
      stdout: (message) => captured.stdout.push(message),
      stderr: (message) => captured.stderr.push(message),
    },
  }
}

describe('runPublishImportsCheck', () => {
  test('a clean tree exits 0 and reports the counts', async () => {
    const { env } = await passFixture()
    const { output, captured } = capture()
    expect(await runPublishImportsCheck(env, output)).toBe(0)
    expect(captured.stdout.join('')).toContain('Published-imports check: 3 publishable packages')
  })

  test('violations print the AUT-476 ruling, the named sites, and the recovery, and exit nonzero', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest(operatorExports),
        files: { 'core-src/operator/index.ts': OPERATOR_SOURCE },
      },
      {
        directory: 'packages/store-service',
        manifest: dependentManifest,
        files: {
          'packages/store-service/src/index.ts': "import '@defrex/autobuild/testing'\n",
        },
      },
    ]
    const root = await buildFixtureRepo(specs)
    const { output, captured } = capture()
    expect(await runPublishImportsCheck(fixtureEnvironment(root, specs), output)).toBe(1)
    const printed = captured.stdout.join('')
    expect(printed).toContain('Ruling (AUT-476)')
    expect(printed).toContain("'@defrex/autobuild/testing' is not exported")
    expect(printed).toContain("exports key './testing' is absent")
    expect(captured.stderr.join('')).toContain('1 published-imports violation(s)')
    expect(captured.stderr.join('')).toContain('Recovery')
  })

  test('a structural failure (no provider) exits 1 without a pass message', async () => {
    const root = await buildFixtureRepo([
      {
        directory: '.',
        manifest: { name: 'not-the-provider', version: '0.1.0', workspaces: ['packages/*'] },
      },
    ])
    const { output, captured } = capture()
    expect(await runPublishImportsCheck(fixtureEnvironment(root, []), output)).toBe(1)
    expect(captured.stderr.join('')).toContain(
      `Could not check published imports against the packed ${PROVIDER} tarball`,
    )
  })
})
