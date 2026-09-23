import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  type PublishImportsCheckEnvironment,
  type PublishImportsReport,
  exportsSubpaths,
  exportsTargets,
  importsSubpaths,
  isProviderSpecifier,
  packedPathOfTarget,
  packedScriptKind,
  realEnvironment,
  resolvePackedClosureTarget,
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

describe('packedPathOfTarget', () => {
  test('strips exactly one leading ./ (finding f_146dfbd3)', () => {
    expect(packedPathOfTarget('./x')).toBe('x')
    expect(packedPathOfTarget('x')).toBe('x')
    expect(packedPathOfTarget('././x')).toBe('./x')
    expect(packedPathOfTarget('./core-src/operator/index.ts')).toBe('core-src/operator/index.ts')
  })
})

describe('resolvePackedClosureTarget', () => {
  const exportsMap = new Map([['./testing', ['./core-src/testing/index.ts']]])
  const importsMap = new Map<string, string[]>()

  test('an exact relative hit resolves to itself', () => {
    expect(
      resolvePackedClosureTarget(['src/util.ts'], 'src/a.ts', './util.ts', exportsMap, importsMap),
    ).toEqual({ kind: 'relative', path: 'src/util.ts' })
  })

  test('a .js specifier resolves to a packed .ts file (TS-style rewrite)', () => {
    expect(
      resolvePackedClosureTarget(['src/x.ts'], 'src/a.ts', './x.js', exportsMap, importsMap),
    ).toEqual({
      kind: 'relative',
      path: 'src/x.ts',
    })
  })

  test('an extensionless specifier hits the packed .ts through same-stem probing', () => {
    expect(
      resolvePackedClosureTarget(['src/x.ts'], 'src/a.ts', './x', exportsMap, importsMap),
    ).toEqual({
      kind: 'relative',
      path: 'src/x.ts',
    })
  })

  test('a directory-index import resolves to <dir>/index.ts, .json last', () => {
    expect(
      resolvePackedClosureTarget(['src/dir/index.ts'], 'src/a.ts', './dir', exportsMap, importsMap),
    ).toEqual({ kind: 'relative', path: 'src/dir/index.ts' })
    expect(
      resolvePackedClosureTarget(
        ['src/dir/index.json'],
        'src/a.ts',
        './dir',
        exportsMap,
        importsMap,
      ),
    ).toEqual({ kind: 'relative', path: 'src/dir/index.json' })
  })

  test('a relative specifier matching nothing is missing with the literal joined path', () => {
    expect(
      resolvePackedClosureTarget(['src/other.ts'], 'src/a.ts', './gone', exportsMap, importsMap),
    ).toEqual({
      kind: 'missing',
      path: 'src/gone',
    })
    expect(
      resolvePackedClosureTarget(
        ['src/other.json'],
        'src/a.ts',
        './data.json',
        exportsMap,
        importsMap,
      ),
    ).toEqual({ kind: 'missing', path: 'src/data.json' })
  })

  test('bare, #-prefixed, and absolute specifiers are external when no imports field matches', () => {
    expect(resolvePackedClosureTarget([], 'src/a.ts', 'zod', exportsMap, importsMap)).toEqual({
      kind: 'external',
    })
    expect(
      resolvePackedClosureTarget([], 'src/a.ts', '#internal/thing', exportsMap, importsMap),
    ).toEqual({
      kind: 'external',
    })
    expect(
      resolvePackedClosureTarget([], 'src/a.ts', '/absolute/path', exportsMap, importsMap),
    ).toEqual({
      kind: 'external',
    })
  })

  test('a provider self-import resolves through the exports map, or self-missing when the key is absent', () => {
    expect(
      resolvePackedClosureTarget(
        [],
        'src/a.ts',
        '@defrex/autobuild/testing',
        exportsMap,
        importsMap,
      ),
    ).toEqual({ kind: 'self', targets: ['./core-src/testing/index.ts'] })
    expect(
      resolvePackedClosureTarget([], 'src/a.ts', '@defrex/autobuild', exportsMap, importsMap),
    ).toEqual({
      kind: 'self-missing',
      subpath: '.',
    })
    expect(
      resolvePackedClosureTarget([], 'src/a.ts', '@defrex/autobuild/nope', exportsMap, importsMap),
    ).toEqual({ kind: 'self-missing', subpath: './nope' })
  })

  test('# specifiers resolve through the imports map, exact match only (seq 36 shape)', () => {
    const imports = importsSubpaths({
      imports: {
        '#internal/util': './core-src/internal/util.ts',
        '#config': { import: './config/index.ts', default: null },
        '#internal/*': ['./core-src/internal/*.ts'],
      },
    })
    // An exact key resolves to its string leaves, conditions objects included.
    expect(
      resolvePackedClosureTarget([], 'src/a.ts', '#internal/util', exportsMap, imports),
    ).toEqual({ kind: 'imports', targets: ['./core-src/internal/util.ts'] })
    expect(resolvePackedClosureTarget([], 'src/a.ts', '#config', exportsMap, imports)).toEqual({
      kind: 'imports',
      targets: ['./config/index.ts'],
    })
    // A specifier only a pattern key could match stays external: exact-match
    // lookup cannot see `#internal/*`, and pattern syntax is unsupported by
    // design (see the mechanics header).
    expect(
      resolvePackedClosureTarget([], 'src/a.ts', '#internal/other', exportsMap, imports),
    ).toEqual({ kind: 'external' })
    // No imports entry at all: external, unchanged from the pre-imports walk.
    expect(resolvePackedClosureTarget([], 'src/a.ts', '#nothing', exportsMap, imports)).toEqual({
      kind: 'external',
    })
  })

  test('kind-aware probing: a non-script extension never resolves across kinds (seq 46 shape)', () => {
    // A .json specifier whose JSON is absent is missing, not a silent match
    // on a packed same-stem .ts.
    expect(
      resolvePackedClosureTarget(
        ['src/data.ts'],
        'src/a.ts',
        './data.json',
        exportsMap,
        importsMap,
      ),
    ).toEqual({ kind: 'missing', path: 'src/data.json' })
    // The exact packed JSON still satisfies the specifier (exact hit is
    // checked first, any kind).
    expect(
      resolvePackedClosureTarget(
        ['src/data.json'],
        'src/a.ts',
        './data.json',
        exportsMap,
        importsMap,
      ),
    ).toEqual({ kind: 'relative', path: 'src/data.json' })
    // A .js specifier no longer falls through to a packed same-stem .json.
    expect(
      resolvePackedClosureTarget(['src/x.json'], 'src/a.ts', './x.js', exportsMap, importsMap),
    ).toEqual({ kind: 'missing', path: 'src/x.js' })
    // Other non-script extensions are exact-only too.
    expect(
      resolvePackedClosureTarget(['src/x.ts'], 'src/a.ts', './README.md', exportsMap, importsMap),
    ).toEqual({ kind: 'missing', path: 'src/README.md' })
    // …but the script-family stem rewrite survives: ./x.js with x.ts packed.
    expect(
      resolvePackedClosureTarget(['src/x.ts'], 'src/a.ts', './x.js', exportsMap, importsMap),
    ).toEqual({ kind: 'relative', path: 'src/x.ts' })
    // Script-family directory-index candidates survive for script specifiers
    // (the candidates join against the specifier's own joined path).
    expect(
      resolvePackedClosureTarget(
        ['src/dir.js/index.ts'],
        'src/a.ts',
        './dir.js',
        exportsMap,
        importsMap,
      ),
    ).toEqual({ kind: 'relative', path: 'src/dir.js/index.ts' })
    // …while a .json directory-index never serves a script specifier.
    expect(
      resolvePackedClosureTarget(
        ['src/dir/index.json'],
        'src/a.ts',
        './dir.js',
        exportsMap,
        importsMap,
      ),
    ).toEqual({ kind: 'missing', path: 'src/dir.js' })
  })
})

describe('importsSubpaths', () => {
  test('collects string and conditions-object leaves, keyed exactly as written', () => {
    expect(
      importsSubpaths({
        imports: {
          '#internal/util': './core-src/internal/util.ts',
          '#config': { import: './config/index.ts', default: null },
        },
      }),
    ).toEqual(
      new Map([
        ['#internal/util', ['./core-src/internal/util.ts']],
        ['#config', ['./config/index.ts']],
      ]),
    )
  })

  test('a manifest without imports yields an empty map (# specifiers stay external)', () => {
    expect(importsSubpaths({ name: 'x' }).size).toBe(0)
    expect(importsSubpaths({ imports: null }).size).toBe(0)
  })
})

/** A minimal dependent so the fixture's `workspaces: ['packages/*']` glob
 * matches (provider-only publish sets are valid, but the workspace reader
 * requires the globbed directories to exist). Its single empty file never
 * imports the provider, so it adds no findings and no closure scans. */
function quietDependent(): FixtureSpec {
  return {
    directory: 'packages/store-service',
    manifest: dependentManifest,
    files: { 'packages/store-service/src/index.ts': 'export {}\n' },
  }
}

/** The AUT-503 counterfactual, made buildable: a provider exporting a packed
 * `./plugin-sdk` target whose `../testing/fixed` dependency is excluded from
 * the packed listing. With `packFixed` the tree is whole (the pass case);
 * without it the export dangles exactly as the recorded observation describes. */
async function closureFixture(packFixed: boolean): Promise<FixtureSpec[]> {
  const providerSpec: FixtureSpec = {
    directory: '.',
    manifest: providerManifest({
      './plugin-sdk': {
        types: './core-src/plugin-sdk/index.ts',
        import: './core-src/plugin-sdk/index.ts',
      },
    }),
    files: {
      'core-src/plugin-sdk/index.ts':
        "import { fixed } from '../testing/fixed'\nexport { fixed }\n",
      'core-src/testing/fixed.ts': 'export const fixed = true\n',
    },
    packedPaths: packFixed ? undefined : ['package.json', 'core-src/plugin-sdk/index.ts'],
  }
  return [providerSpec, quietDependent()]
}

describe('provider exports-target closure walk (AUT-507)', () => {
  test('a pack exclusion that dangles a packed exports target fails the check naming key, importer, and missing path', async () => {
    const specs = await closureFixture(false)
    const root = await buildFixtureRepo(specs)
    const env = fixtureEnvironment(root, specs)
    const report = await scanPublishedImports(env)
    expect(report.violations).toEqual([
      {
        kind: 'missing-closure-file',
        packageName: PROVIDER,
        exportsKey: './plugin-sdk',
        importerPath: 'core-src/plugin-sdk/index.ts',
        missingPath: 'core-src/testing/fixed',
      },
    ])
    const { output, captured } = capture()
    expect(await runPublishImportsCheck(env, output)).toBe(1)
    const printed = captured.stdout.join('')
    expect(printed).toContain("'./plugin-sdk'")
    expect(printed).toContain('core-src/plugin-sdk/index.ts')
    expect(printed).toContain('core-src/testing/fixed')
    expect(printed).toContain('cannot load the module')
  })

  test('the dangling file is found transitively, with the direct importer named', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
        }),
        files: {
          'core-src/plugin-sdk/index.ts': "import './middle'\n",
          'core-src/plugin-sdk/middle.ts': "import './deep'\n",
          'core-src/plugin-sdk/deep.ts': "import '../testing/fixed'\n",
          'core-src/testing/fixed.ts': 'export const fixed = true\n',
        },
        packedPaths: [
          'package.json',
          'core-src/plugin-sdk/index.ts',
          'core-src/plugin-sdk/middle.ts',
          'core-src/plugin-sdk/deep.ts',
        ],
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([
      {
        kind: 'missing-closure-file',
        packageName: PROVIDER,
        exportsKey: './plugin-sdk',
        importerPath: 'core-src/plugin-sdk/deep.ts',
        missingPath: 'core-src/testing/fixed',
      },
    ])
  })

  test('the unmodified tree passes: the same fixture with the file packed finds nothing and scans the closure', async () => {
    const specs = await closureFixture(true)
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([])
    expect(report.providerClosureFiles).toBe(2)
  })

  test('fail-closed: an unparseable reachable provider script is an unparseable-file naming the provider', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
        }),
        files: {
          'core-src/plugin-sdk/index.ts': "import './broken'\n",
          'core-src/plugin-sdk/broken.ts': 'this is definitely not typescript',
        },
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([
      { kind: 'unparseable-file', packageName: PROVIDER, path: './core-src/plugin-sdk/broken.ts' },
    ])
  })

  test('a reachable packed .json is a presence-checked leaf: no violation, not counted as scanned', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
        }),
        files: {
          'core-src/plugin-sdk/index.ts':
            "import identity from './data.json'\nexport { identity }\n",
          'core-src/plugin-sdk/data.json': '{"identity": 1}',
        },
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([])
    // Only the script file is scanned; the JSON leaf is never read or parsed.
    expect(report.providerClosureFiles).toBe(1)
  })

  test('a reachable .json omitted from the pack is a missing-closure-file, like any reachable file', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
        }),
        files: {
          'core-src/plugin-sdk/index.ts':
            "import identity from './data.json'\nexport { identity }\n",
          'core-src/plugin-sdk/data.json': '{"identity": 1}',
        },
        packedPaths: ['package.json', 'core-src/plugin-sdk/index.ts'],
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([
      {
        kind: 'missing-closure-file',
        packageName: PROVIDER,
        exportsKey: './plugin-sdk',
        importerPath: 'core-src/plugin-sdk/index.ts',
        missingPath: 'core-src/plugin-sdk/data.json',
      },
    ])
  })

  test('the ./-prefixed real manifest shape seeds walks (coverage is normalization, not luck)', async () => {
    // Every fixture above already uses the `./`-prefixed target shape; this
    // test pins the count directly: the target's normalized path resolves and
    // the walk actually scans provider files.
    const { env } = await passFixture()
    const report = await scanPublishedImports(env)
    expect(report.violations).toEqual([])
    expect(report.providerClosureFiles).toBeGreaterThan(0)
  })

  test('a target whose normalized path is not packed produces unresolved-exports-target and no walk', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({ './ghost': { import: './core-src/ghost.ts' } }),
        files: {
          // The worktree has the file; the pack listing does not.
          'core-src/ghost.ts': 'export const ghost = true\n',
        },
        packedPaths: ['package.json'],
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(
      report.violations.map((violation) =>
        violation.kind === 'unresolved-exports-target'
          ? { kind: violation.kind, target: violation.target }
          : violation,
      ),
    ).toEqual([{ kind: 'unresolved-exports-target', target: './ghost → ./core-src/ghost.ts' }])
    expect(report.providerClosureFiles).toBe(0)
  })

  test('mutual imports terminate with no findings and no duplicate scans', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({ './plugin-sdk': { import: './core-src/a.ts' } }),
        files: {
          'core-src/a.ts': "import './b'\nexport const a = true\n",
          'core-src/b.ts': "import './a'\nexport const b = true\n",
        },
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([])
    expect(report.providerClosureFiles).toBe(2)
  })

  test('a self-import jumps to its exports key targets; an absent key is a missing-export naming the provider', async () => {
    const jumping: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
          './testing': { import: './core-src/testing/index.ts' },
        }),
        files: {
          'core-src/plugin-sdk/index.ts': "import '@defrex/autobuild/testing'\n",
          'core-src/testing/index.ts': 'export const testing = true\n',
        },
      },
      quietDependent(),
    ]
    const jumpRoot = await buildFixtureRepo(jumping)
    const jumpReport = await scanPublishedImports(fixtureEnvironment(jumpRoot, jumping))
    expect(jumpReport.violations).toEqual([])
    // Both the seed and the self-jump target were scanned.
    expect(jumpReport.providerClosureFiles).toBe(2)

    const missing: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
        }),
        files: {
          'core-src/plugin-sdk/index.ts': "import '@defrex/autobuild/nope'\n",
        },
      },
      quietDependent(),
    ]
    const missingRoot = await buildFixtureRepo(missing)
    const missingReport = await scanPublishedImports(fixtureEnvironment(missingRoot, missing))
    expect(missingReport.violations).toEqual([
      {
        kind: 'missing-export',
        packageName: PROVIDER,
        specifier: `${PROVIDER}/nope`,
        subpath: './nope',
        path: './core-src/plugin-sdk/index.ts',
        line: 1,
      },
    ])
  })

  test('dedup: two importers of the same missing file yield two findings; one importer twice yields one', async () => {
    const twoImporters: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
        }),
        files: {
          'core-src/plugin-sdk/index.ts': "import './a'\nimport './b'\n",
          'core-src/plugin-sdk/a.ts': "import '../missing/x'\n",
          'core-src/plugin-sdk/b.ts': "import '../missing/x'\n",
        },
        packedPaths: [
          'package.json',
          'core-src/plugin-sdk/index.ts',
          'core-src/plugin-sdk/a.ts',
          'core-src/plugin-sdk/b.ts',
        ],
      },
      quietDependent(),
    ]
    const twoRoot = await buildFixtureRepo(twoImporters)
    const twoReport = await scanPublishedImports(fixtureEnvironment(twoRoot, twoImporters))
    expect(
      twoReport.violations.map((violation) =>
        violation.kind === 'missing-closure-file' ? violation.importerPath : violation.kind,
      ),
    ).toEqual(['core-src/plugin-sdk/a.ts', 'core-src/plugin-sdk/b.ts'])

    const oneImporterTwice: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
        }),
        files: {
          'core-src/plugin-sdk/index.ts': "import './gone'\nimport './gone'\n",
        },
      },
      quietDependent(),
    ]
    const onceRoot = await buildFixtureRepo(oneImporterTwice)
    const onceReport = await scanPublishedImports(fixtureEnvironment(onceRoot, oneImporterTwice))
    expect(onceReport.violations).toHaveLength(1)
  })

  test('multi-key: a dangling file is reported once per reaching key; the shared cache counts a file once', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './one': { import: './core-src/one/index.ts' },
          './two': { import: './core-src/two/index.ts' },
        }),
        files: {
          'core-src/one/index.ts': "import '../shared/dep'\n",
          'core-src/two/index.ts': "import '../shared/dep'\n",
          'core-src/shared/dep.ts': 'export const dep = true\n',
        },
        packedPaths: ['package.json', 'core-src/one/index.ts', 'core-src/two/index.ts'],
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(
      report.violations.map((violation) =>
        violation.kind === 'missing-closure-file' ? violation.exportsKey : violation.kind,
      ),
    ).toEqual(['./one', './two'])
    // The two seed files were each read and parsed once across both walks.
    expect(report.providerClosureFiles).toBe(2)

    const shared: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './one': { import: './core-src/shared/index.ts' },
          './two': { import: './core-src/shared/index.ts' },
        }),
        files: { 'core-src/shared/index.ts': 'export const shared = true\n' },
      },
      quietDependent(),
    ]
    const sharedRoot = await buildFixtureRepo(shared)
    const sharedReport = await scanPublishedImports(fixtureEnvironment(sharedRoot, shared))
    expect(sharedReport.violations).toEqual([])
    // One file walked under two keys counts once.
    expect(sharedReport.providerClosureFiles).toBe(1)
  })

  test('per-target seeding: a key mixing a present script target with an absent one still walks the script target (seq 31/45)', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './mixed': {
            import: './core-src/plugin-sdk/index.ts',
            // A sibling target absent from the pack: today's all-or-nothing
            // seed filter would skip the key entirely.
            types: './core-src/ghost/index.d.ts',
          },
        }),
        files: {
          'core-src/plugin-sdk/index.ts': "import '../testing/fixed'\n",
          'core-src/ghost/index.d.ts': 'export type Ghost = never\n',
        },
        // The script target and its unpacked transitive import are packed;
        // the ghost target is not.
        packedPaths: ['package.json', 'core-src/plugin-sdk/index.ts'],
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(
      report.violations.map((violation) =>
        violation.kind === 'missing-closure-file' ? violation : violation.kind,
      ),
    ).toContainEqual({
      kind: 'missing-closure-file',
      packageName: PROVIDER,
      exportsKey: './mixed',
      importerPath: 'core-src/plugin-sdk/index.ts',
      missingPath: 'core-src/testing/fixed',
    })
    // Exactly one dangling finding: the absent ghost target is flagged by the
    // pre-existing `unresolved-exports-target` probe, not double-reported here.
    expect(report.violations).toHaveLength(2)
    expect(report.violations.some((entry) => entry.kind === 'unresolved-exports-target')).toBe(true)

    // Pass direction with a present non-script sibling target: the walk still
    // scans the script target's closure despite the `.json` sibling.
    const packed: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './mixed': { import: './core-src/plugin-sdk/index.ts', types: './core-src/data.json' },
        }),
        files: {
          'core-src/plugin-sdk/index.ts': "import '../testing/fixed'\nexport { fixed }\n",
          'core-src/testing/fixed.ts': 'export const fixed = true\n',
          'core-src/data.json': '{}',
        },
      },
      quietDependent(),
    ]
    const packedRoot = await buildFixtureRepo(packed)
    const packedReport = await scanPublishedImports(fixtureEnvironment(packedRoot, packed))
    expect(packedReport.violations).toEqual([])
    expect(packedReport.providerClosureFiles).toBe(2)
  })

  test('imports-field mappings are walked: a packed # specifier resolves, an unpacked one dangles (seq 36)', async () => {
    const make = (packUtil: boolean): FixtureSpec[] => [
      {
        directory: '.',
        manifest: {
          ...providerManifest({
            './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
          }),
          imports: { '#internal/util': './core-src/internal/util.ts' },
        },
        files: {
          'core-src/plugin-sdk/index.ts': "import { util } from '#internal/util'\n",
          'core-src/internal/util.ts': 'export const util = true\n',
        },
        packedPaths: packUtil ? undefined : ['package.json', 'core-src/plugin-sdk/index.ts'],
      },
      quietDependent(),
    ]
    const packedRoot = await buildFixtureRepo(make(true))
    const packedReport = await scanPublishedImports(fixtureEnvironment(packedRoot, make(true)))
    expect(packedReport.violations).toEqual([])
    // The imports-mapped file was reached and scanned.
    expect(packedReport.providerClosureFiles).toBe(2)

    const danglingRoot = await buildFixtureRepo(make(false))
    const danglingReport = await scanPublishedImports(fixtureEnvironment(danglingRoot, make(false)))
    expect(danglingReport.violations).toEqual([
      {
        kind: 'missing-closure-file',
        packageName: PROVIDER,
        exportsKey: './plugin-sdk',
        importerPath: 'core-src/plugin-sdk/index.ts',
        missingPath: 'core-src/internal/util.ts',
      },
    ])
  })

  test('an imports value naming a bare dependency is skipped like an external specifier', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: {
          ...providerManifest({
            './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
          }),
          imports: { '#dep': 'zod' },
        },
        files: {
          'core-src/plugin-sdk/index.ts': "import { z } from '#dep'\nexport { z }\n",
        },
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([])
    // Only the seed was scanned; the bare target added no walk step.
    expect(report.providerClosureFiles).toBe(1)
  })

  test('kind-aware probing in the walk: a dangling .json import is reported, not masked by a packed same-stem .ts (seq 46)', async () => {
    const specs: FixtureSpec[] = [
      {
        directory: '.',
        manifest: providerManifest({
          './plugin-sdk': { import: './core-src/plugin-sdk/index.ts' },
        }),
        files: {
          // The specifier names a JSON file the pack omits; the same-stem .ts
          // is packed, but a script file cannot satisfy `import './data.json'`.
          'core-src/plugin-sdk/index.ts': "import identity from './data.json'\n",
          'core-src/plugin-sdk/data.ts': 'export const identity = true\n',
        },
      },
      quietDependent(),
    ]
    const root = await buildFixtureRepo(specs)
    const report = await scanPublishedImports(fixtureEnvironment(root, specs))
    expect(report.violations).toEqual([
      {
        kind: 'missing-closure-file',
        packageName: PROVIDER,
        exportsKey: './plugin-sdk',
        importerPath: 'core-src/plugin-sdk/index.ts',
        missingPath: 'core-src/plugin-sdk/data.json',
      },
    ])
  })

  test('real tree: the closure walk scans the packed provider closure and finds nothing dangling', async () => {
    // Closes f_146dfbd3's lint blind spot: `lint` sees 0 violations for both a
    // real pass and a vacuous one, so this pins providerClosureFiles > 0
    // against the real `bun pm pack --dry-run` listings, the real manifest's
    // `./`-prefixed targets, and the real closure.
    const report = await scanPublishedImports(realEnvironment)
    expect(report.violations).toEqual([])
    expect(report.providerClosureFiles).toBeGreaterThan(0)
  }, 120000)
})
