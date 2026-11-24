import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import {
  exportsSubpaths,
  exportsTargets,
  importsSubpaths,
  isProviderSpecifier,
  packedPathOfTarget,
  packedScriptKind,
  resolvePackedClosureTarget,
  subpathOfProviderSpecifier,
} from './publish-imports-check'

const POSTGRES = '@defrex/autobuild-postgres-store'

const SERVICE = '@defrex/autobuild-hosted-store-service'

const PROVIDER = '@defrex/autobuild'

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
    for (const [packed, importer, specifier, expected] of [
      [['src/dir/index.ts'], 'src/a.ts', './dir', { kind: 'relative', path: 'src/dir/index.ts' }],
      [
        ['src/dir/index.json'],
        'src/a.ts',
        './dir',
        { kind: 'relative', path: 'src/dir/index.json' },
      ],
    ] as const)
      expect(
        resolvePackedClosureTarget(packed, importer, specifier, exportsMap, importsMap),
      ).toEqual(expected)
  })

  test('a relative specifier matching nothing is missing with the literal joined path', () => {
    for (const [packed, importer, specifier, expected] of [
      [
        ['src/other.ts'],
        'src/a.ts',
        './gone',
        {
          kind: 'missing',
          path: 'src/gone',
        },
      ],
      [['src/other.json'], 'src/a.ts', './data.json', { kind: 'missing', path: 'src/data.json' }],
    ] as const)
      expect(
        resolvePackedClosureTarget(packed, importer, specifier, exportsMap, importsMap),
      ).toEqual(expected)
  })

  test('bare, #-prefixed, and absolute specifiers are external when no imports field matches', () => {
    for (const [packed, importer, specifier, expected] of [
      [
        [],
        'src/a.ts',
        'zod',
        {
          kind: 'external',
        },
      ],
      [
        [],
        'src/a.ts',
        '#internal/thing',
        {
          kind: 'external',
        },
      ],
      [
        [],
        'src/a.ts',
        '/absolute/path',
        {
          kind: 'external',
        },
      ],
    ] as const)
      expect(
        resolvePackedClosureTarget(packed, importer, specifier, exportsMap, importsMap),
      ).toEqual(expected)
  })

  test('a provider self-import resolves through the exports map, or self-missing when the key is absent', () => {
    for (const [packed, importer, specifier, expected] of [
      [
        [],
        'src/a.ts',
        '@defrex/autobuild/testing',
        { kind: 'self', targets: ['./core-src/testing/index.ts'] },
      ],
      [
        [],
        'src/a.ts',
        '@defrex/autobuild',
        {
          kind: 'self-missing',
          subpath: '.',
        },
      ],
      [[], 'src/a.ts', '@defrex/autobuild/nope', { kind: 'self-missing', subpath: './nope' }],
    ] as const)
      expect(
        resolvePackedClosureTarget(packed, importer, specifier, exportsMap, importsMap),
      ).toEqual(expected)
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
    for (const [packed, importer, specifier, expected] of [
      [['src/data.ts'], 'src/a.ts', './data.json', { kind: 'missing', path: 'src/data.json' }],
      [['src/data.json'], 'src/a.ts', './data.json', { kind: 'relative', path: 'src/data.json' }],
      [['src/x.json'], 'src/a.ts', './x.js', { kind: 'missing', path: 'src/x.js' }],
      [['src/x.ts'], 'src/a.ts', './README.md', { kind: 'missing', path: 'src/README.md' }],
      [['src/x.ts'], 'src/a.ts', './x.js', { kind: 'relative', path: 'src/x.ts' }],
      [
        ['src/dir.js/index.ts'],
        'src/a.ts',
        './dir.js',
        { kind: 'relative', path: 'src/dir.js/index.ts' },
      ],
      [['src/dir/index.json'], 'src/a.ts', './dir.js', { kind: 'missing', path: 'src/dir.js' }],
    ] as const)
      expect(
        resolvePackedClosureTarget(packed, importer, specifier, exportsMap, importsMap),
      ).toEqual(expected)
  })

  test('a dotted extensionless directory specifier keeps the directory-index probe (AUT-518)', () => {
    for (const [packed, importer, specifier, expected] of [
      [
        ['src/foo.bar/index.ts'],
        'src/a.ts',
        './foo.bar',
        { kind: 'relative', path: 'src/foo.bar/index.ts' },
      ],
      [
        ['src/v1.2/index.ts'],
        'src/a.ts',
        './v1.2',
        { kind: 'relative', path: 'src/v1.2/index.ts' },
      ],
    ] as const)
      expect(
        resolvePackedClosureTarget(packed, importer, specifier, exportsMap, importsMap),
      ).toEqual(expected)
  })

  test('an unrecognized extension is never stripped from the stem (no cross-stem silent pass)', () => {
    for (const [packed, importer, specifier, expected] of [
      [['src/v1.ts'], 'src/a.ts', './v1.2', { kind: 'missing', path: 'src/v1.2' }],
      [['src/foo.ts'], 'src/a.ts', './foo.bar', { kind: 'missing', path: 'src/foo.bar' }],
    ] as const)
      expect(
        resolvePackedClosureTarget(packed, importer, specifier, exportsMap, importsMap),
      ).toEqual(expected)
  })

  test('a dotted extensionless specifier probes stem and .json variants with the whole path as stem', () => {
    for (const [packed, importer, specifier, expected] of [
      [['src/foo.bar.ts'], 'src/a.ts', './foo.bar', { kind: 'relative', path: 'src/foo.bar.ts' }],
      [
        ['src/foo.bar.json'],
        'src/a.ts',
        './foo.bar',
        { kind: 'relative', path: 'src/foo.bar.json' },
      ],
      [
        ['src/foo.bar/index.json'],
        'src/a.ts',
        './foo.bar',
        { kind: 'relative', path: 'src/foo.bar/index.json' },
      ],
    ] as const)
      expect(
        resolvePackedClosureTarget(packed, importer, specifier, exportsMap, importsMap),
      ).toEqual(expected)
  })

  test('known non-script kinds stay exact-match-only by enumeration, not by the blanket rule', () => {
    // '.md' is in KNOWN_NON_SCRIPT_EXTENSIONS, so neither the stem nor the
    // directory-index probe runs even when absurd pack shapes exist.
    expect(
      resolvePackedClosureTarget(
        ['src/data.md.ts', 'src/data.md/index.ts'],
        'src/a.ts',
        './data.md',
        exportsMap,
        importsMap,
      ),
    ).toEqual({ kind: 'missing', path: 'src/data.md' })
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
