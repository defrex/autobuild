import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  type PublishDependenciesCheckEnvironment,
  type PublishDependenciesViolation,
  REVIEWED_ALLOWANCES,
  declaredNames,
  isBareSpecifier,
  isBuiltinSpecifier,
  packageNameOfSpecifier,
  realEnvironment,
  runPublishDependenciesCheck,
  scanPublishedDependencies,
} from './publish-dependencies-check'

/**
 * Fixture strategy, as in publish-imports-check.integration.test.ts: a real on-disk
 * mini-repo with manifests and sources, and a fake pack runner returning a
 * canned bun-shaped listing per package directory.
 */

interface FixtureSpec {
  /** Repo-root-relative package directory ('.' for the root package). */
  directory: string
  manifest: Record<string, unknown>
  /** Package-directory-relative files. */
  files?: Record<string, string>
  /** Overrides the packed listing (defaults to package.json + files). */
  packedPaths?: readonly string[]
  /** Makes the pack fail. */
  packFails?: boolean
}

const createdRoots: string[] = []

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

const ROOT = '@defrex/autobuild'
const SERVICE = '@defrex/autobuild-hosted-store-service'

async function fixture(
  specs: readonly FixtureSpec[],
): Promise<PublishDependenciesCheckEnvironment> {
  const root = await mkdtemp(join(tmpdir(), 'publish-dependencies-fixture-'))
  createdRoots.push(root)
  for (const spec of specs) {
    const directory = join(root, spec.directory)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify(spec.manifest))
    for (const [path, contents] of Object.entries(spec.files ?? {})) {
      const absolute = join(directory, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, contents)
    }
  }
  return {
    repoRoot: root,
    pack: async (request) => {
      const spec = specs.find(
        (candidate) => resolve(join(root, candidate.directory)) === resolve(request.cwd),
      )
      if (spec === undefined || spec.packFails === true) {
        return { exitCode: 1, stdout: '', stderr: `cannot pack ${relative(root, request.cwd)}` }
      }
      const paths = spec.packedPaths ?? ['package.json', ...Object.keys(spec.files ?? {})]
      const listing = ['bun pack v1.4.0', '', ...paths.map((path) => `packed 1B ${path}`), ''].join(
        '\n',
      )
      return { exitCode: 0, stdout: listing, stderr: '' }
    },
    readFile: (path) => readFile(path, 'utf8'),
  }
}

function rootSpec(
  overrides: Partial<FixtureSpec> & { dependencies?: Record<string, string> } = {},
): FixtureSpec {
  return {
    directory: '.',
    manifest: {
      name: ROOT,
      version: '1.0.0',
      workspaces: ['packages/*'],
      dependencies: overrides.dependencies ?? { zod: '^4.4.3' },
    },
    files: { 'core/index.ts': 'export const value = 1\n' },
    ...overrides,
  }
}

function serviceSpec(
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
  extra: Partial<FixtureSpec> = {},
): FixtureSpec {
  return {
    directory: 'packages/service',
    manifest: { name: SERVICE, version: '1.0.0', dependencies: { zod: '^4.4.3' }, ...manifest },
    files,
    ...extra,
  }
}

function otherSpec(manifest: Record<string, unknown>, files: Record<string, string>): FixtureSpec {
  return {
    directory: 'packages/other',
    manifest: { name: '@example/other', version: '1.0.0', ...manifest },
    files,
  }
}

/** Violations other than the stale real-repository allowances, which no
 * fixture package matches. */
async function violationsOf(
  specs: readonly FixtureSpec[],
): Promise<PublishDependenciesViolation[]> {
  const report = await scanPublishedDependencies(await fixture(specs))
  return report.violations.filter((violation) => violation.kind !== 'stale-allowance')
}

describe('pure helpers', () => {
  test('package names of scoped and unscoped specifiers', () => {
    expect(packageNameOfSpecifier('zod')).toBe('zod')
    expect(packageNameOfSpecifier('next/server')).toBe('next')
    expect(packageNameOfSpecifier('@a/b')).toBe('@a/b')
    expect(packageNameOfSpecifier('@a/b/c')).toBe('@a/b')
  })

  test('relative, subpath-import, absolute and scheme specifiers are not bare', () => {
    for (const specifier of ['./x', '../x', '.', '..', '/abs/x', '#internal', 'data:text/js,1']) {
      expect(isBareSpecifier(specifier)).toBe(false)
    }
    expect(isBareSpecifier('zod')).toBe(true)
    expect(isBareSpecifier('@a/b/c')).toBe(true)
  })

  test('Node and Bun builtins', () => {
    for (const specifier of ['node:fs', 'fs/promises', 'path', 'bun', 'bun:test']) {
      expect(isBuiltinSpecifier(specifier)).toBe(true)
    }
    expect(isBuiltinSpecifier('zod')).toBe(false)
  })

  test('declared names span dependencies, peers and optional dependencies only', () => {
    expect(
      [
        ...declaredNames({
          dependencies: { a: '1' },
          peerDependencies: { b: '1' },
          optionalDependencies: { c: '1' },
          devDependencies: { d: '1' },
        }),
      ].sort(),
    ).toEqual(['a', 'b', 'c'])
  })
})

describe('undeclared imports', () => {
  test('an undeclared runtime import names the package, file, line and specifier', async () => {
    const violations = await violationsOf([
      rootSpec(),
      serviceSpec({}, { 'src/a.ts': "\nimport { x } from 'left-pad/sub'\n" }),
    ])
    expect(violations).toEqual([
      {
        kind: 'undeclared-import',
        packageName: SERVICE,
        path: 'src/a.ts',
        line: 2,
        specifier: 'left-pad/sub',
        dependency: 'left-pad',
      },
    ])
  })

  test('type-only, re-export, dynamic import and require forms are each caught', async () => {
    const violations = await violationsOf([
      rootSpec(),
      serviceSpec(
        {},
        {
          'src/type.ts': "import type { T } from 'type-only'\nexport type U = T\n",
          'src/reexport.ts': "export { x } from 'reexported'\n",
          'src/dynamic.ts': "export const load = () => import('dynamic')\n",
          'src/require.cjs': "module.exports = require('required')\n",
        },
      ),
    ])
    expect(
      violations.map((violation) => 'dependency' in violation && violation.dependency),
    ).toEqual(['type-only', 'reexported', 'dynamic', 'required'])
  })

  test('declaring in any consumer-installed section passes; self-imports and builtins pass', async () => {
    const violations = await violationsOf([
      rootSpec(),
      serviceSpec(
        {
          dependencies: { zod: '^4.4.3', a: '1.0.0' },
          peerDependencies: { b: '1.0.0' },
          optionalDependencies: { c: '1.0.0' },
        },
        {
          'src/a.ts': [
            "import 'a'",
            "import 'b/sub'",
            "import 'c'",
            "import 'zod'",
            `import '${SERVICE}/web/auth'`,
            "import 'node:fs'",
            "import 'bun:test'",
            "import './local'",
            '',
          ].join('\n'),
        },
      ),
    ])
    expect(violations).toEqual([])
  })

  test('a devDependencies-only declaration fails', async () => {
    const violations = await violationsOf([
      rootSpec(),
      serviceSpec({ devDependencies: { dev: '1.0.0' } }, { 'src/a.ts': "import 'dev'\n" }),
    ])
    expect(violations.map((violation) => violation.kind)).toEqual(['undeclared-import'])
  })

  test('non-script packed files and unpacked worktree files are not scanned', async () => {
    const violations = await violationsOf([
      rootSpec(),
      serviceSpec(
        {},
        {
          'README.md': "import 'markdown'\n",
          'data.json': '{"import": "json"}\n',
          'src/unpacked.ts': "import 'unpacked'\n",
        },
        { packedPaths: ['package.json', 'README.md', 'data.json'] },
      ),
    ])
    expect(violations).toEqual([])
  })

  test('an unparseable packed file is a violation', async () => {
    const violations = await violationsOf([
      rootSpec(),
      serviceSpec({}, { 'src/broken.ts': 'export const = \n' }),
    ])
    expect(violations).toEqual([
      { kind: 'unparseable-file', packageName: SERVICE, path: 'src/broken.ts' },
    ])
  })
})

describe('reviewed allowances', () => {
  const allowance = REVIEWED_ALLOWANCES.find((entry) => entry.specifier === 'server-only')!

  const allowanceFixture = (
    files: Record<string, string>,
    manifest: Record<string, unknown> = {},
  ) => violationsOfAll([rootSpec(), serviceSpec(manifest, files)])

  async function violationsOfAll(specs: readonly FixtureSpec[]) {
    return (await scanPublishedDependencies(await fixture(specs))).violations.filter(
      (violation) =>
        violation.kind !== 'stale-allowance' || violation.allowance.packageName === SERVICE,
    )
  }

  const dispatcherFile = {
    'app/api/dispatch/route.ts': "import '@defrex/autobuild-hosted-dispatcher/runtime'\n",
  }

  test('an exact (package, file, specifier) allowance passes', async () => {
    expect(
      await allowanceFixture({ [allowance.path]: "import 'server-only'\n", ...dispatcherFile }),
    ).toEqual([])
  })

  test('the same specifier from another file fails: there is no blanket exemption', async () => {
    const violations = await allowanceFixture({
      [allowance.path]: "import 'server-only'\n",
      'app/other.ts': "import 'server-only'\n",
      ...dispatcherFile,
    })
    expect(violations).toEqual([
      {
        kind: 'undeclared-import',
        packageName: SERVICE,
        path: 'app/other.ts',
        line: 1,
        specifier: 'server-only',
        dependency: 'server-only',
      },
    ])
  })

  test('the same file with another specifier fails', async () => {
    const violations = await allowanceFixture({
      [allowance.path]: "import 'server-only'\nimport 'server-only/extra'\n",
      ...dispatcherFile,
    })
    expect(violations.map((violation) => violation.kind)).toEqual(['undeclared-import'])
  })

  test('an allowance whose import is gone is stale', async () => {
    const violations = await allowanceFixture({
      [allowance.path]: 'export {}\n',
      ...dispatcherFile,
    })
    expect(violations).toEqual([{ kind: 'stale-allowance', allowance }])
  })

  test('an allowance whose package is now declared is stale', async () => {
    const violations = await allowanceFixture(
      { [allowance.path]: "import 'server-only'\n", ...dispatcherFile },
      { dependencies: { zod: '^4.4.3', 'server-only': '0.0.1' } },
    )
    expect(violations).toEqual([{ kind: 'stale-allowance', allowance }])
  })
})

describe('shared-dependency drift', () => {
  const driftOf = async (
    manifest: Record<string, unknown>,
    rootDependencies?: Record<string, string>,
  ) => violationsOf([rootSpec({ dependencies: rootDependencies }), serviceSpec(manifest)])

  test('a range that admits the root range passes', async () => {
    expect(await driftOf({ dependencies: { zod: '^4.4.3' } })).toEqual([])
    expect(await driftOf({ dependencies: { zod: '^4.0.0' } })).toEqual([])
    expect(await driftOf({ peerDependencies: { zod: '^4.4.3' }, dependencies: {} })).toEqual([])
  })

  test('a range that does not admit the root range fails', async () => {
    for (const range of ['^4.5.0', '~4.4.3']) {
      expect(await driftOf({ dependencies: { zod: range } })).toEqual([
        {
          kind: 'shared-range-drift',
          packageName: SERVICE,
          dependency: 'zod',
          range,
          rootRange: '^4.4.3',
        },
      ])
    }
  })

  test('the drift rule covers every name the root declares, not only zod', async () => {
    const violations = await violationsOf([
      rootSpec({ dependencies: { zod: '^4.4.3', '@vercel/sandbox': '^3.1.0' } }),
      otherSpec({ dependencies: { '@vercel/sandbox': '^3.2.0' } }, {}),
    ])
    expect(violations.map((violation) => violation.kind)).toEqual(['shared-range-drift'])
  })

  test('a missing required zod declaration fails by name', async () => {
    expect(await driftOf({ dependencies: {} })).toEqual([
      {
        kind: 'missing-shared-declaration',
        packageName: SERVICE,
        dependency: 'zod',
        rootRange: '^4.4.3',
      },
    ])
  })

  test('an invalid range fails', async () => {
    expect(await driftOf({ dependencies: { zod: 'not a range' } })).toEqual([
      { kind: 'invalid-range', packageName: SERVICE, dependency: 'zod', range: 'not a range' },
    ])
  })

  test('a workspace: value on a name the root does not declare is ignored', async () => {
    expect(
      await driftOf({ dependencies: { zod: '^4.4.3', '@example/sibling': 'workspace:*' } }),
    ).toEqual([])
  })
})

describe('failure handling', () => {
  test('a failed pack is a violation', async () => {
    const violations = await violationsOf([rootSpec(), serviceSpec({}, {}, { packFails: true })])
    expect(violations).toEqual([
      {
        kind: 'pack',
        packageName: SERVICE,
        directory: 'packages/service',
        detail: 'cannot pack packages/service',
      },
    ])
  })

  test('a thrown enumeration exits 1', async () => {
    const env = await fixture([serviceSpec({})])
    const messages: string[] = []
    const exitCode = await runPublishDependenciesCheck(env, {
      stdout: (message) => messages.push(message),
      stderr: (message) => messages.push(message),
    })
    expect(exitCode).toBe(1)
    expect(messages.join('')).toContain('Could not check published dependency declarations')
  })

  test('violations exit 1 with a line naming the package, file and specifier', async () => {
    const env = await fixture([rootSpec(), serviceSpec({}, { 'src/a.ts': "import 'left-pad'\n" })])
    const stdout: string[] = []
    const exitCode = await runPublishDependenciesCheck(env, {
      stdout: (message) => stdout.push(message),
      stderr: () => {},
    })
    expect(exitCode).toBe(1)
    expect(stdout.join('')).toContain(
      `${SERVICE}: src/a.ts:1: 'left-pad' imports left-pad, which the packed manifest does not declare`,
    )
  })
})

test('real tree: every published package declares what its packed source imports', async () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = await runPublishDependenciesCheck(realEnvironment, {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  })
  expect({ exitCode, stdout: stdout.join(''), stderr: stderr.join('') }).toMatchObject({
    exitCode: 0,
    stderr: '',
  })
}, 120000)
