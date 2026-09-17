import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import {
  collectSpecifiers,
  findBoundaryViolations,
  isScannedTestFile,
  type PackageBoundaryCheckEnvironment,
  type PackageBoundaryCheckOutput,
  resolvesIntoSiblingSrc,
  runPackageBoundaryCheck,
  scanWorkspace,
  type ScannedFile,
  UNPARSEABLE_MODULE,
} from './package-boundary-check'

// This file lives in tools/, which the guard never scans (it only scans test
// files under packages/<pkg>/src/), so the offending specifiers can be spelled
// out literally.
const SIBLING_SRC_STORE = '../../postgres-store/src/store'
const SIBLING_SRC = '../../postgres-store/src'

const PACKAGES = ['core', 'hosted-dispatcher', 'hosted-store-service', 'postgres-store']

const file = (path: string, contents: string): ScannedFile => ({ path, contents })

const scan = (files: ScannedFile[]): string[] =>
  findBoundaryViolations(files, PACKAGES).map(
    (violation) => `${violation.path}:${violation.line}: ${violation.specifier}`,
  )

describe('findBoundaryViolations', () => {
  test('a clean file has nothing to report', () => {
    expect(
      scan([
        file(
          'packages/core/src/store/adapter.test.ts',
          [
            "import { adapter } from './adapter'",
            "import { catalog } from '../../events/catalog'",
            "import { testing } from '@defrex/autobuild/testing'",
            "import { store } from '@defrex/autobuild-postgres-store/store'",
            "import { semver } from 'semver'",
            "import type { Config } from '@defrex/autobuild-hosted-store-service/service'",
          ].join('\n'),
        ),
      ]),
    ).toEqual([])
  })

  test('reports the path, line, and specifier of a cross-package src import', () => {
    const violations = findBoundaryViolations(
      [file('packages/core/src/a.test.ts', `import { x } from '${SIBLING_SRC_STORE}'\n`)],
      PACKAGES,
    )

    expect(violations).toEqual([
      {
        path: 'packages/core/src/a.test.ts',
        line: 1,
        specifier: SIBLING_SRC_STORE,
        fromPackage: 'core',
        toPackage: 'postgres-store',
      },
    ])
  })

  test('catches type-only imports, export … from, dynamic import(), and require()', () => {
    expect(
      scan([
        file(
          'packages/core/src/a.test.ts',
          [
            `import type { T } from '${SIBLING_SRC_STORE}'`,
            `export { x } from '${SIBLING_SRC_STORE}'`,
            `const m = import('${SIBLING_SRC_STORE}')`,
            `const r = require('${SIBLING_SRC_STORE}')`,
          ].join('\n'),
        ),
      ]),
    ).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:2: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:3: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:4: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('catches a side-effect import of a sibling src path', () => {
    expect(scan([file('packages/core/src/a.test.ts', `import '${SIBLING_SRC_STORE}'\n`)])).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('catches an extensionless sibling src specifier', () => {
    expect(
      scan([file('packages/core/src/a.test.ts', `import { x } from '${SIBLING_SRC}'\n`)]),
    ).toEqual([`packages/core/src/a.test.ts:1: ${SIBLING_SRC}`])
  })

  test('catches a specifier inside a multi-line import statement', () => {
    const contents = ['import {', '  migratePostgres,', `} from '${SIBLING_SRC}/schema'`].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:3: ${SIBLING_SRC}/schema`,
    ])
  })

  test('import text inside a line comment is not an offender', () => {
    expect(
      scan([file('packages/core/src/a.test.ts', `// import { x } from '${SIBLING_SRC_STORE}'\n`)]),
    ).toEqual([])
  })

  test('a block/JSDoc comment documenting a forbidden import and commented-out code are clean', () => {
    const contents = [
      '/**',
      ` * The old boundary breach was \`import { store } from '${SIBLING_SRC_STORE}'\`;`,
      ' * it now goes through the public subpath export.',
      ' */',
      `// import { store } from '${SIBLING_SRC_STORE}'`,
      "import { store } from '@defrex/autobuild-postgres-store/store'",
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([])
  })

  test('import text inside a string literal or template-literal interior is clean', () => {
    const contents = [
      `const hint = "import { x } from '${SIBLING_SRC_STORE}' to load the store"`,
      `const doc = 'see import { x } from "${SIBLING_SRC_STORE}"'`,
      `const usage = \`import { x } from '${SIBLING_SRC_STORE}' when wiring manually\``,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([])
  })

  test('comment and string text does not mask a real sibling-src import in the same file', () => {
    const contents = [
      `// import { x } from '${SIBLING_SRC_STORE}'`,
      `const hint = "from '${SIBLING_SRC_STORE}'"`,
      `import { x } from '${SIBLING_SRC_STORE}'`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:3: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('comment-interleaved require/import argument positions are still flagged (documented widening)', () => {
    // The header doc comment's "comment-interleaved argument positions"
    // widening: comments are trivia and never occupy an argument slot, so the
    // string literal is still the pinned arguments[0] and is reported with its
    // real text and line — the regexes this parser replaced never matched
    // these forms at all.
    const contents = [
      `const r = require(/* c */ '${SIBLING_SRC_STORE}')`,
      `const m = import(/* c */ '${SIBLING_SRC_STORE}')`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:2: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('comment text is never the specifier, and an allowed specifier in an interleaved position is clean', () => {
    // An implementation that misread comment text as the specifier would flag
    // the sibling-src path inside the block comments below; the real argument
    // in every case here is the allowed './x' literal.
    const contents = [
      "const a = require(/* c */ './x')",
      "const b = import(/* c */ './x')",
      `const c = require(/* '${SIBLING_SRC_STORE}' */ './x')`,
      `const d = import(/* '${SIBLING_SRC_STORE}' */ './x')`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([])
  })

  test('a dynamic import inside a template interpolation is still flagged', () => {
    // `${…}` is real code, not template interior: the parser descends into it.
    const contents = `const message = \`load it: \${import('${SIBLING_SRC_STORE}')}\`\n`
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('a template-literal specifier is not collected (coverage preserved)', () => {
    // The raw-text regexes this scanner replaces never matched template
    // specifiers, and widening would change coverage.
    const contents = `const m = import(\`\${'${SIBLING_SRC_STORE}'}\`)\n`
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([])
  })

  test("the import's option-bag value is not an offender — only the specifier is", () => {
    // Pre-fix, the argument-subtree walk collected the bag value too, yielding
    // two violation lines; only the specifier slot is collected now.
    const contents = `const m = import('${SIBLING_SRC_STORE}', { with: { type: '${SIBLING_SRC_STORE}' } })
`
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('a second argument and a computed argument are not offenders', () => {
    const contents = [
      `const opts = require('./adapter', createOptions('${SIBLING_SRC_STORE}'))`,
      `const joined = require(path.join(__dirname, '${SIBLING_SRC}/x'))`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([])
  })

  test('a nested collected call is reported once, not twice', () => {
    // Pre-fix, both the outer argument-subtree walk and the inner
    // CallExpression visit collected the same specifier.
    const contents = `const m = require(require('${SIBLING_SRC_STORE}'))
`
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('require.call collects the argument slot only — an array is not a specifier', () => {
    const contents = [
      `const a = require.call(null, '${SIBLING_SRC_STORE}')`,
      `const b = require.call(null, ['${SIBLING_SRC_STORE}'])`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('require.apply collects only element 0 of the arguments array', () => {
    // Element 1 also names a sibling-src path on purpose: an all-elements
    // implementation would emit a second violation line here.
    const contents = `const e = require.apply(null, ['${SIBLING_SRC_STORE}', '${SIBLING_SRC}/other'])
`
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('a leading-literal concatenation specifier is not collected (documented narrowing)', () => {
    // The replaced regexes matched the leading literal of a concatenation;
    // the specifier-position rule no longer does. Documented narrowing.
    const contents = [
      `const a = require('${SIBLING_SRC}/' + name)`,
      `const b = import('${SIBLING_SRC}/' + name)`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([])
  })

  test('the unparseable sentinel is a full Violation with pinned derivations', () => {
    const violations = findBoundaryViolations(
      [file('packages/core/src/broken.test.ts', "import { from 'x'\n")],
      PACKAGES,
    )
    expect(violations).toEqual([
      {
        path: 'packages/core/src/broken.test.ts',
        line: 1,
        specifier: '<unparseable module>',
        fromPackage: 'core',
        toPackage: '<unknown>',
      },
    ])
  })

  test('an unparseable file outside every package is not reported, sentinel included', () => {
    expect(scan([file('tools/broken.test.ts', "import { from 'x'\n")])).toEqual([])
  })

  test('an unparseable file fails closed with the sentinel violation', () => {
    const contents = "import { from '../../postgres-store/src/store'\n"
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      'packages/core/src/a.test.ts:1: <unparseable module>',
    ])
  })

  test('a valid JSX .test.tsx is not misreported as unparseable', () => {
    // The parse gate uses the file's script kind, so JSX parses as JSX.
    const contents = [
      'export const C = () => <div>store</div>',
      `const hint = "import { x } from '${SIBLING_SRC_STORE}'"`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.tsx', contents)])).toEqual([])
  })

  test('a real sibling-src import in a JSX .test.tsx is still flagged', () => {
    const contents = [
      'export const C = () => <div/>',
      `import { x } from '${SIBLING_SRC_STORE}'`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.tsx', contents)])).toEqual([
      `packages/core/src/a.test.tsx:2: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('import-equals and require-ish forms are still flagged', () => {
    expect(
      scan([
        file(
          'packages/core/src/a.test.ts',
          [
            `import x = require('${SIBLING_SRC_STORE}')`,
            `const m = module.require('${SIBLING_SRC_STORE}')`,
            `const d = require.call(null, '${SIBLING_SRC_STORE}')`,
            `const e = require.apply(null, ['${SIBLING_SRC_STORE}'])`,
            `const f = new require('${SIBLING_SRC_STORE}')`,
          ].join('\n'),
        ),
      ]),
    ).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:2: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:3: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:4: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:5: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('fully type-only import and export forms stay flagged (documented divergence)', () => {
    // Ruled behavior: this guard enforces a source-convention boundary — a
    // fully type-only import still makes tsc resolve types from the sibling's
    // src and still couples the test to sibling internals, so it violates the
    // convention exactly like a runtime import and stays flagged. The
    // store-service dispatcher scan excludes these same forms on purpose (its
    // boundary is runtime-load; erased imports load nothing) — the divergence
    // between the two scanners is deliberate, not drift.
    expect(
      scan([
        file(
          'packages/core/src/a.test.ts',
          [
            `import type { T } from '${SIBLING_SRC_STORE}'`,
            `export type { T } from '${SIBLING_SRC_STORE}'`,
          ].join('\n'),
        ),
      ]),
    ).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:2: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('type-position import() — import type nodes — are still flagged', () => {
    // `import('…').Type` and `typeof import('…')` parse as an ImportTypeNode,
    // not a call; the raw-text regexes this scanner replaces matched the
    // import(…) text wherever it appeared, so type nodes stay flagged too.
    const contents = [
      `type Store = import('${SIBLING_SRC_STORE}').Store`,
      `type Mod = typeof import('${SIBLING_SRC_STORE}')`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:1: ${SIBLING_SRC_STORE}`,
      `packages/core/src/a.test.ts:2: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('an import() type reference inside a string is clean while a real one is flagged', () => {
    const contents = [
      `const hint = "type Store = import('${SIBLING_SRC_STORE}').Store"`,
      `type Store = import('${SIBLING_SRC_STORE}').Store`,
    ].join('\n')
    expect(scan([file('packages/core/src/a.test.ts', contents)])).toEqual([
      `packages/core/src/a.test.ts:2: ${SIBLING_SRC_STORE}`,
    ])
  })

  test('does not flag a relative import that resolves into the same package', () => {
    expect(
      scan([
        file(
          'packages/core/src/a.test.ts',
          "import { x } from './x'\nimport { y } from '../src/store/adapter'\n",
        ),
      ]),
    ).toEqual([])
  })

  test('does not flag a relative path that merely contains a package-name-shaped segment', () => {
    // From packages/core/src/a/, `../postgres-store/src/x` normalizes to
    // packages/core/src/postgres-store/src/x — not a real import.
    expect(
      scan([
        file('packages/core/src/a/b.test.ts', "import { x } from '../postgres-store/src/x'\n"),
      ]),
    ).toEqual([])
  })

  test('ignores files outside packages/, so tools/ paths are never flagged', () => {
    expect(
      scan([
        file(
          'tools/dashboard-capture.test.ts',
          "import { spawnExec } from '../packages/core/src/ports/workspace/git-worktree'\n",
        ),
      ]),
    ).toEqual([])
  })
})

describe('collectSpecifiers', () => {
  test('ScriptKind.JS collects require() and dynamic import() from CJS content without the unparseable sentinel', () => {
    const contents = [
      "const { store } = require('@defrex/autobuild-postgres-store/store')",
      'async function load() {',
      "  return import('@defrex/autobuild-hosted-dispatcher/dispatcher')",
      '}',
      'module.exports = { store, load }',
    ].join('\n')
    const collected = collectSpecifiers(contents, ts.ScriptKind.JS)
    expect(collected).toEqual([
      { specifier: '@defrex/autobuild-postgres-store/store', line: 1 },
      { specifier: '@defrex/autobuild-hosted-dispatcher/dispatcher', line: 3 },
    ])
    expect(collected.some((entry) => entry.specifier === UNPARSEABLE_MODULE)).toBe(false)
  })

  test('ScriptKind.JS labels the diagnostics pass module.js: TS-only syntax in a JS-kind input fails closed', () => {
    // The only observable effect of the ScriptKind.JS -> 'module.js' arm of
    // collectSpecifiers' transpile fileName mapping: TS-only syntax in a
    // JS-kind input is a parse error (TS8010 under typescript@5.9.3), so the
    // collector fails closed with the sentinel. Under the pre-AUT-479 label
    // ('module.ts') the same input produces no Error diagnostic — verified —
    // so this result fails if the mapping ever reverts; detection alone (JS
    // as a syntactic subset of TS) could not discriminate. A future
    // TypeScript that stops emitting the diagnostic fails this pin on
    // purpose: re-verify and re-pin, as the spec prescribes.
    const collected = collectSpecifiers('const x: number = 1', ts.ScriptKind.JS)
    expect(collected).toEqual([{ specifier: UNPARSEABLE_MODULE, line: 1 }])
  })

  test('ScriptKind.JSX collects the import from a file containing JSX', () => {
    const contents = [
      "import { Widget } from './widget'",
      'export const node = <Widget name="store" />',
    ].join('\n')
    const collected = collectSpecifiers(contents, ts.ScriptKind.JSX)
    expect(collected).toEqual([{ specifier: './widget', line: 1 }])
    expect(collected.some((entry) => entry.specifier === UNPARSEABLE_MODULE)).toBe(false)
  })
})

describe('resolvesIntoSiblingSrc', () => {
  test('resolves a specifier landing on a sibling src root itself', () => {
    expect(resolvesIntoSiblingSrc('packages/core/src/a.test.ts', SIBLING_SRC, PACKAGES)).toEqual({
      toPackage: 'postgres-store',
    })
  })

  test('returns undefined for subpath package imports', () => {
    expect(
      resolvesIntoSiblingSrc('packages/core/src/a.test.ts', '@defrex/autobuild/testing', PACKAGES),
    ).toBeUndefined()
  })
})

describe('isScannedTestFile', () => {
  test('accepts *.test.ts and *.test.tsx under packages/<pkg>/src, including *.live.test.ts', () => {
    expect(isScannedTestFile('packages/core/src/a.test.ts', PACKAGES)).toBe(true)
    expect(isScannedTestFile('packages/core/src/a.test.tsx', PACKAGES)).toBe(true)
    expect(isScannedTestFile('packages/postgres-store/src/store.live.test.ts', PACKAGES)).toBe(true)
  })

  test('rejects production files, non-src paths, and files outside packages/', () => {
    expect(isScannedTestFile('packages/core/src/a.ts', PACKAGES)).toBe(false)
    expect(isScannedTestFile('packages/core/spec/a.test.ts', PACKAGES)).toBe(false)
    expect(isScannedTestFile('tools/vendored-skills-sync.test.ts', PACKAGES)).toBe(false)
  })
})

interface StubFile {
  bytes: Uint8Array
}

const text = (contents: string): StubFile => ({
  bytes: new TextEncoder().encode(contents),
})

function harness(files: Record<string, StubFile>) {
  const stdout: string[] = []
  const stderr: string[] = []

  const env: PackageBoundaryCheckEnvironment = {
    listWorkspacePackages: async () => PACKAGES,
    listFilesUnderPackages: async () => Object.keys(files),
    readFile: async (path) => {
      const entry = files[path]
      if (!entry) throw new Error(`unexpected path ${path}`)
      return entry.bytes
    },
  }

  const output: PackageBoundaryCheckOutput = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  }

  return { env, output, stderr, stdout }
}

describe('scanWorkspace', () => {
  test('feeds only packages/<pkg>/src test files to the scanner', async () => {
    const stub = harness({
      'packages/core/src/real.test.ts': text('export {}\n'),
      'packages/core/src/production.ts': text(`import { x } from '${SIBLING_SRC_STORE}'\n`),
      'packages/core/spec/outside.test.ts': text(`import { x } from '${SIBLING_SRC_STORE}'\n`),
      'tools/vendored-skills-sync.test.ts': text(
        "import { readDistSkills } from '../packages/core/src/cli/init'\n",
      ),
    })

    const report = await scanWorkspace(stub.env)

    expect(report.scanned).toBe(1)
    expect(report.violations).toEqual([])
  })

  test('reports violations found in the collected files', async () => {
    const stub = harness({
      'packages/core/src/real.test.ts': text(`import { x } from '${SIBLING_SRC_STORE}'\n`),
    })

    const report = await scanWorkspace(stub.env)

    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]?.fromPackage).toBe('core')
    expect(report.violations[0]?.toPackage).toBe('postgres-store')
  })
})

describe('runPackageBoundaryCheck', () => {
  test('reports every violation on stdout and the convention on stderr', async () => {
    const stub = harness({
      'packages/core/src/one.test.ts': text(`import { x } from '${SIBLING_SRC_STORE}'\n`),
      'packages/hosted-store-service/src/two.test.ts': text(
        "import { y } from '../../postgres-store/src/migrate'\n",
      ),
    })

    expect(await runPackageBoundaryCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stdout).toEqual([
      "packages/core/src/one.test.ts:1: specifier '../../postgres-store/src/store' reaches packages/postgres-store/src from core tests\n",
      "packages/hosted-store-service/src/two.test.ts:1: specifier '../../postgres-store/src/migrate' reaches packages/postgres-store/src from hosted-store-service tests\n",
    ])
    expect(stub.stderr.join('')).toContain('subpath exports')
    expect(stub.stderr.join('')).toContain('2 violation(s) found')
  })

  test('an unparseable test file fails the run and names the file on stdout', async () => {
    const stub = harness({ 'packages/core/src/broken.test.ts': text("import { from 'x'\n") })

    expect(await runPackageBoundaryCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stdout).toEqual([
      "packages/core/src/broken.test.ts:1: specifier '<unparseable module>' reaches <unknown> from core tests\n",
    ])
  })

  test('a clean tree exits 0 with a tally', async () => {
    const stub = harness({ 'packages/core/src/clean.test.ts': text("import { x } from './x'\n") })

    expect(await runPackageBoundaryCheck(stub.env, stub.output)).toBe(0)
    expect(stub.stdout).toEqual([
      'Package boundary check: 1 test files scanned, no cross-package src imports.\n',
    ])
    expect(stub.stderr).toEqual([])
  })

  test('a failing enumeration exits non-zero rather than reporting a clean tree', async () => {
    const stub = harness({})
    stub.env.listFilesUnderPackages = async () => {
      throw new Error('readdir: no such directory')
    }

    expect(await runPackageBoundaryCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stderr.join('')).toContain('no such directory')
  })

  test('a failing read exits non-zero rather than reporting a clean tree', async () => {
    const stub = harness({ 'packages/core/src/locked.test.ts': text('') })
    stub.env.readFile = async () => {
      throw new Error('EACCES: permission denied')
    }

    expect(await runPackageBoundaryCheck(stub.env, stub.output)).toBe(1)
    expect(stub.stderr.join('')).toContain('EACCES')
  })
})
