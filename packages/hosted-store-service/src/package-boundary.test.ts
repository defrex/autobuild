import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'

/**
 * The store service hosts state only: after the hosted dispatcher moved to
 * `@defrex/autobuild-hosted-dispatcher`, no module here may import it and the
 * manifest must neither export it nor depend on it or on any workspace
 * sandbox provider. A deployment that installs only the store service then
 * never loads the dispatcher's kernel/provider closure.
 */
const packageDirectory = join(import.meta.dir, '..')

async function readManifest(): Promise<{
  exports?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}> {
  return JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>
    dependencies?: Record<string, unknown>
    peerDependencies?: Record<string, unknown>
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

/**
 * Specifiers that would load the dispatcher. Applied to every import form the
 * scanner recognizes. The relative branch also matches extensioned
 * (`./dispatcher.js`) and subpath (`./dispatcher/index.js`) forms of the
 * dispatcher module — re-adding the module under an explicit extension must
 * not slip past the scan — while a name that merely begins with `dispatcher`
 * (`./dispatcherish`, `./dispatcher-utils`) does not match: the boundary is
 * the dispatcher module itself, not any name that starts with it.
 *
 * The package branch is anchored the same way at package-name granularity: it
 * matches the exact package name `@defrex/autobuild-hosted-dispatcher` or its
 * `/` subpaths — including raw template text whose next character after the
 * name is `/` (a subpath), `$` from an interpolation (which can resolve to the
 * real dispatcher at runtime, so it stays flagged — fail-closed), or
 * end-of-string — and does not match a name that merely extends the prefix
 * with a package-name character (`-tools`, `_x`, `2`, `.js`). The boundary is
 * the npm package-name alphabet, not merely end-of-string or `/`: anything a
 * package name could continue with means the specifier is a different, longer
 * package name.
 */
const DISPATCHER_SPECIFIER =
  /^(?:\.\/dispatcher(?:$|[./]))|(?:^@defrex\/autobuild-hosted-dispatcher(?:$|[^A-Za-z0-9._-]))/

/**
 * Parser-based extraction of dispatcher specifiers — NOT regex-based. The
 * parser is the TypeScript compiler's own AST (the same parser that implements
 * this repo's `verbatimModuleSyntax: true` emit), so the guard models exactly
 * the module loads the repo's own toolchain can produce. Because a real parser
 * scopes specifiers to import statements, dispatcher-import text confined to a
 * line or block comment, a string/template-literal interior, or a
 * regex-literal body can never yield an offender (a leading `#!` shebang is
 * comment trivia to the parser, not an import).
 *
 * Flagged: every import form that survives emit as a module load — static
 * `from` specifiers (including `export ... from` and inline type-only named
 * bindings like `import { type T } from '...'`, which `verbatimModuleSyntax`
 * preserves as `import {} from '...'` / `export {} from '...'` and therefore
 * still executes the module), bare side-effect `import '...'`, dynamic
 * `import('...')` with either a quoted or a template-literal specifier (a
 * template-literal specifier is reported as its raw source text, interpolation
 * included — `` import(`@defrex/autobuild-hosted-dispatcher/${name}`) `` is
 * flagged), extensioned and subpath relative forms (`./dispatcher.js`,
 * `./dispatcher/index.js` — see `DISPATCHER_SPECIFIER`), and require forms
 * (defensively; see below).
 *
 * Require forms are flagged even though the package is ESM: the reachability
 * caveat is that no `require` binding is in scope today, so every require-side
 * gap is latent — this coverage guards a future regression (a `createRequire`
 * import or a CommonJS interop revert), not live behavior. Flagged require
 * forms: `require('...')` and `` require(`...`) `` (template-literal
 * specifiers are reported as raw source text, like dynamic import),
 * `new require(...)`, `x.require(...)` for any receiver (`module.require`,
 * `globalThis.require`, ... — fail-closed, and harmless because only
 * dispatcher-matching specifiers are reported), and
 * `require.call(...)` / `require.apply(...)` (their argument subtrees are
 * walked, so `require.apply(null, ['./dispatcher'])` is caught too). The
 * realistic `createRequire` form —
 * `const require = createRequire(import.meta.url); require('...')` — binds the
 * identifier `require` and is flagged by the plain-identifier branch.
 * Consciously not flagged: `require.bind(...)` (deferred invocation, not one
 * of the recorded forms) and element-access callees like
 * `require['call'](...)` (a general import-analysis rewrite is out of scope).
 * A scan that missed side-effect or dynamic forms would let
 * the dispatcher's kernel/provider closure silently reintroduce itself.
 *
 * Intentionally not flagged: the fully type-only forms `import type { T } from
 * '...'` and `export type { T } from '...'` — both are erased even under
 * `verbatimModuleSyntax` and cannot load the dispatcher. This exclusion is
 * deliberate and differs from `tools/package-boundary-check.ts` (the
 * package-boundary lint), which keeps fully type-only imports flagged — that
 * guard enforces a source-convention boundary (a type-only import still makes
 * `tsc` resolve types from the sibling's `src`, so the test still couples to
 * sibling internals), while this scan enforces a runtime-load boundary and an
 * erased import loads nothing. The split is the ruled behavior, not drift:
 * each scanner's comment documents it, so do not silently align one with the
 * other.
 *
 * Fail-closed edges: a file that fails to parse (syntactic errors) yields the
 * `<unparseable module>` sentinel so the tree walk reports the whole file as
 * an offender rather than skipping it; ambiguity errs toward flagging.
 */
const UNPARSEABLE_MODULE = '<unparseable module>'

/**
 * Expressions that denote `require` itself: the bare identifier, or a property
 * access whose name is `require` (any receiver — `module.require`,
 * `globalThis.require`, ...). Matching any receiver is fail-closed and
 * harmless: only dispatcher-matching specifiers are ever reported.
 */
function isRequireishExpression(node: ts.Expression): boolean {
  return (
    (ts.isIdentifier(node) && node.text === 'require') ||
    (ts.isPropertyAccessExpression(node) && node.name.text === 'require')
  )
}

export function dispatcherSpecifiers(text: string): string[] {
  const { diagnostics } = ts.transpileModule(text, { reportDiagnostics: true })
  if ((diagnostics ?? []).some((d) => d.category === ts.DiagnosticCategory.Error)) {
    return [UNPARSEABLE_MODULE]
  }
  const sourceFile = ts.createSourceFile(
    'module.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const specifiers: string[] = []
  /**
   * Collect dispatcher specifiers from every string literal and template
   * literal in an argument subtree, in visit order. Shared by dynamic `import`
   * and the require forms so both report template-literal specifiers the same
   * way: raw source text between the backticks, interpolation included. Only
   * subtrees rooted at real call positions are walked, so string or template
   * interiors elsewhere in the file can never yield an offender.
   */
  const collectFromArgument = (argument: ts.Expression): void => {
    const visitArgument = (n: ts.Node): void => {
      if (ts.isStringLiteral(n)) {
        if (DISPATCHER_SPECIFIER.test(n.text)) specifiers.push(n.text)
      } else if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
        const raw = n.getText(sourceFile).slice(1, -1)
        if (DISPATCHER_SPECIFIER.test(raw)) specifiers.push(raw)
      }
      n.forEachChild(visitArgument)
    }
    visitArgument(argument)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // `import type ...` is fully erased; every other import declaration
      // (including `import { type T } ...`) survives verbatimModuleSyntax
      // emit and loads the module. Excluding the fully type-only form here is
      // the ruled divergence from tools/package-boundary-check.ts, which
      // flags type-only imports deliberately under its source-convention
      // boundary — see the scanner doc comment above.
      if (
        node.importClause?.isTypeOnly !== true &&
        DISPATCHER_SPECIFIER.test(node.moduleSpecifier.text)
      ) {
        specifiers.push(node.moduleSpecifier.text)
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      // `export type ... from` is fully erased; `export { type T } from`,
      // `export * from`, and `export * as ns from` all survive emit.
      node.isTypeOnly !== true &&
      DISPATCHER_SPECIFIER.test(node.moduleSpecifier.text)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      DISPATCHER_SPECIFIER.test(node.moduleReference.expression.text)
    ) {
      // `import x = require('...')` — no type-only erasure exists for it.
      specifiers.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        if (argument) collectFromArgument(argument)
      } else if (isRequireishExpression(node.expression)) {
        // `require(...)` and any `x.require(...)` — every argument subtree is
        // examined, so template-literal specifiers (`` require(`./dispatcher`)
        // ``) and nested-string forms (`` require(`./dispatcher` + suffix) ``)
        // are caught, consistent with the dynamic-import branch.
        for (const argument of node.arguments) collectFromArgument(argument)
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'call' || node.expression.name.text === 'apply') &&
        isRequireishExpression(node.expression.expression)
      ) {
        // `require.call(...)` / `require.apply(...)` — the subtree walk also
        // catches `require.apply(null, ['./dispatcher'])` through the array
        // literal.
        for (const argument of node.arguments) collectFromArgument(argument)
      }
    } else if (ts.isNewExpression(node) && isRequireishExpression(node.expression)) {
      // `new require(...)` — non-call require form the delivered raw-text scan
      // caught by substring accident.
      for (const argument of node.arguments ?? []) collectFromArgument(argument)
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return specifiers
}

/**
 * Manifest dependency names that denote the dispatcher package. Reuses the
 * already-anchored `DISPATCHER_SPECIFIER` so the manifest filter and the
 * import scanner agree on where the package name ends: the exact name
 * `@defrex/autobuild-hosted-dispatcher` (or, fail-closed, a `/` subpath of
 * it) is reported, while a name that merely extends the prefix (`-tools`,
 * `_2`, `2`) is not — the same unbounded-substring over-flagging
 * `name.includes('hosted-dispatcher')` allowed. Dependency keys are bare
 * package names, so only the regex's package branch can fire on a real
 * manifest; the relative branch matching a hypothetical `./dispatcher` key
 * is inert fail-closed behavior (no such key is a legal package name).
 */
export function dispatcherDependencyNames(names: readonly string[]): string[] {
  return names.filter((name) => DISPATCHER_SPECIFIER.test(name))
}

describe('hosted-store-service package boundary', () => {
  test('manifest has no dispatcher export and no dispatcher or provider dependency', async () => {
    const manifest = await readManifest()
    expect(Object.keys(manifest.exports ?? {})).not.toContain('./dispatcher')
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]
    expect(dispatcherDependencyNames(dependencyNames)).toEqual([])
    expect(
      dependencyNames.filter(
        (name) => name === '@vercel/sandbox' || name.startsWith('@defrex/autobuild-'),
      ),
    ).toEqual(['@defrex/autobuild-postgres-store'])
  })

  test('dependency filter is anchored to the exact dispatcher package name', () => {
    // Positive: the exact dispatcher package name — and, fail-closed, a
    // subpath-shaped key — is reported.
    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher'])).toEqual([
      '@defrex/autobuild-hosted-dispatcher',
    ])
    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher/kernel'])).toEqual([
      '@defrex/autobuild-hosted-dispatcher/kernel',
    ])

    // The pinned negative case (AUT-449): a dependency whose name merely
    // extends the dispatcher package prefix is a different package and must
    // not be reported — the old name.includes('hosted-dispatcher') filter
    // over-flagged it.
    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher-tools'])).toEqual([])

    // Other prefix-extending package-name characters stay unreported too.
    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher_2'])).toEqual([])
    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher2'])).toEqual([])

    // Legitimate dependency names stay clean.
    expect(
      dispatcherDependencyNames([
        '@defrex/autobuild-postgres-store',
        '@defrex/autobuild-hosted-store-service',
        '@defrex/autobuild',
        'pg',
      ]),
    ).toEqual([])
  })

  test('no module imports the dispatcher', async () => {
    const files = await sourceFiles(join(packageDirectory, 'src'))
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const specifier of dispatcherSpecifiers(text)) {
        offenders.push(`${file}: ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('scan flags every import form that could load the dispatcher', () => {
    // Positive: every import form that could load the dispatcher is flagged.
    expect(
      dispatcherSpecifiers("import { kernel } from '@defrex/autobuild-hosted-dispatcher/kernel'"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/kernel'])
    expect(dispatcherSpecifiers("import './dispatcher'")).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers("const m = await import('@defrex/autobuild-hosted-dispatcher')"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher'])
    expect(dispatcherSpecifiers("const d = require('./dispatcher')")).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers(
        `const m = await import(
  './dispatcher'
)`,
      ),
    ).toEqual(['./dispatcher'])
    // Re-export forms load the dispatcher too.
    expect(dispatcherSpecifiers("export * from './dispatcher'")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("export { kernel } from './dispatcher'")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("export * as ns from './dispatcher'")).toEqual(['./dispatcher'])

    // Evasion guard: a real dynamic import inside a template interpolation is
    // still flagged even though the surrounding text is a template literal.
    // (The `\${` escapes keep the fixture's interpolation out of this file's
    // own syntax; the fixture text still carries a real `${...}`.)
    expect(dispatcherSpecifiers(`const x = \`\${await import('./dispatcher')}\``)).toEqual([
      './dispatcher',
    ])

    // Template-literal dynamic import specifiers are flagged too — plain,
    // package, and interpolated forms. An interpolated specifier is reported
    // as its raw text, so the dispatcher prefix is still caught.
    expect(dispatcherSpecifiers('const m = await import(`./dispatcher`)')).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers('const m = await import(`@defrex/autobuild-hosted-dispatcher`)'),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher'])
    expect(
      dispatcherSpecifiers(
        `const m = await import(\`@defrex/autobuild-hosted-dispatcher/\${name}\`)`,
      ),
    ).toEqual([`@defrex/autobuild-hosted-dispatcher/\${name}`])
    // A template specifier shaped by a surrounding expression is flagged too —
    // any backtick text inside a dynamic import() argument is examined.
    expect(dispatcherSpecifiers('const m = await import(`./dispatcher` + suffix)')).toEqual([
      './dispatcher',
    ])

    // Extensioned and subpath forms of the relative dispatcher specifier are
    // flagged too — re-adding the module under an explicit extension must not
    // slip past the scan.
    expect(dispatcherSpecifiers("import './dispatcher.js'")).toEqual(['./dispatcher.js'])
    expect(dispatcherSpecifiers("import x from './dispatcher/index.js'")).toEqual([
      './dispatcher/index.js',
    ])
    expect(dispatcherSpecifiers("export * from './dispatcher.js'")).toEqual(['./dispatcher.js'])
    expect(dispatcherSpecifiers("const m = await import('./dispatcher.js')")).toEqual([
      './dispatcher.js',
    ])

    // Negative controls: legitimate specifiers stay clean.
    expect(
      dispatcherSpecifiers("import { store } from '@defrex/autobuild-postgres-store'"),
    ).toEqual([])
    expect(dispatcherSpecifiers("import './service'")).toEqual([])
    expect(dispatcherSpecifiers("void import('@defrex/autobuild-postgres-store')")).toEqual([])
    expect(dispatcherSpecifiers("import { x } from '@defrex/autobuild'")).toEqual([])

    // Backtick specifiers unrelated to the dispatcher stay clean; interpolation
    // alone is not a false positive.
    expect(dispatcherSpecifiers('void import(`./service`)')).toEqual([])
    expect(dispatcherSpecifiers('import(`@defrex/autobuild-postgres-store`)')).toEqual([])
    expect(dispatcherSpecifiers(`import(\`./\${name}\`)`)).toEqual([])

    // A name that merely begins with `dispatcher` is not the dispatcher module;
    // the extensioned/subpath widening must not over-flag these.
    expect(dispatcherSpecifiers("import './dispatcherish'")).toEqual([])
    expect(dispatcherSpecifiers("import './dispatcher-utils'")).toEqual([])
    expect(dispatcherSpecifiers("const m = await import('./dispatcherish')")).toEqual([])
    expect(dispatcherSpecifiers("const m = await import('./dispatcher-utils')")).toEqual([])

    // The same boundary rule at package-name granularity: a package whose name
    // merely extends the dispatcher package prefix is a different package and
    // must not be flagged, in any import form.
    expect(
      dispatcherSpecifiers("import { x } from '@defrex/autobuild-hosted-dispatcher-tools'"),
    ).toEqual([])
    expect(
      dispatcherSpecifiers("const m = await import('@defrex/autobuild-hosted-dispatcher-tools')"),
    ).toEqual([])
    expect(dispatcherSpecifiers('require(`@defrex/autobuild-hosted-dispatcher-tools`)')).toEqual([])
    // Fail-closed: an interpolation directly after the package name can resolve
    // to the real dispatcher at runtime, so the raw text stays flagged.
    expect(
      dispatcherSpecifiers(
        `const m = await import(\`@defrex/autobuild-hosted-dispatcher\${path}\`)`,
      ),
    ).toEqual([`@defrex/autobuild-hosted-dispatcher\${path}`])

    // Limitation, by design: a dynamic import whose specifier is a bare
    // variable (`import(pkgVar)`) or whose text is reshaped by interpolation
    // (e.g. `import(`./dispatch${kind}`)`) cannot be resolved statically
    // and stays outside this scan's claimed reach.
  })

  test('require scan catches template-literal and non-call require forms', () => {
    // Template-literal require specifiers are flagged, reported as raw source
    // text — the same convention the dynamic-import branch ships.
    expect(dispatcherSpecifiers('const d = require(`./dispatcher`)')).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers(`const d = require(\`@defrex/autobuild-hosted-dispatcher/\${name}\`)`),
    ).toEqual([`@defrex/autobuild-hosted-dispatcher/\${name}`])
    // An argument expression containing a template literal is examined too.
    expect(dispatcherSpecifiers('const d = require(`./dispatcher` + suffix)')).toEqual([
      './dispatcher',
    ])

    // Non-call require forms the delivered raw-text scan caught by substring
    // accident are flagged again.
    expect(dispatcherSpecifiers("new require('./dispatcher')")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("module.require('./dispatcher')")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("globalThis.require('./dispatcher')")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("require.call(null, './dispatcher')")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("require.apply(null, ['./dispatcher'])")).toEqual(['./dispatcher'])

    // The realistic createRequire form binds the identifier `require`, so the
    // plain-identifier branch flags it.
    expect(
      dispatcherSpecifiers(
        "const require = createRequire(import.meta.url)\nrequire('./dispatcher')",
      ),
    ).toEqual(['./dispatcher'])

    // Negative controls: non-dispatcher specifiers stay clean in every form.
    expect(dispatcherSpecifiers("module.require('./service')")).toEqual([])
    expect(dispatcherSpecifiers('const d = require(`./service`)')).toEqual([])
    expect(dispatcherSpecifiers("require.call(null, './service')")).toEqual([])
    expect(dispatcherSpecifiers("new require('./service')")).toEqual([])

    // Consciously not flagged (see the scanner doc comment):
    // `require.bind(...)` defers the call, and element-access callees like
    // `require['call'](...)` are beyond the recorded forms.
    expect(dispatcherSpecifiers("const f = require.bind(null, './dispatcher')")).toEqual([])
    expect(dispatcherSpecifiers("require['call'](null, './dispatcher')")).toEqual([])
  })

  test('dispatcher-import text inside comments or strings is not an offender', () => {
    // The ticket: raw text matching would flag documentation and
    // commented-out code. The parser scopes specifiers to import statements,
    // so none of these can load the dispatcher.
    expect(dispatcherSpecifiers("// import './dispatcher'")).toEqual([])
    expect(dispatcherSpecifiers("// import '@defrex/autobuild-hosted-dispatcher'")).toEqual([])
    expect(
      dispatcherSpecifiers(
        `/*
import './dispatcher'
*/`,
      ),
    ).toEqual([])
    expect(
      dispatcherSpecifiers(
        `/**
 * @see import '@defrex/autobuild-hosted-dispatcher'
 */
export const x = 1`,
      ),
    ).toEqual([])
    expect(dispatcherSpecifiers(`const hint = "import './dispatcher' to load the kernel"`)).toEqual(
      [],
    )
    expect(dispatcherSpecifiers(`const hint = 'import "./dispatcher" to load the kernel'`)).toEqual(
      [],
    )
    expect(dispatcherSpecifiers(`const doc = "see import './dispatcher'"`)).toEqual([])
    expect(
      dispatcherSpecifiers(`const doc = \`import './dispatcher' when wiring the kernel manually\``),
    ).toEqual([])
    // Require-flavored text in comments and string interiors stays clean too:
    // only subtrees rooted at real require-ish call positions are examined.
    expect(dispatcherSpecifiers("// require('./dispatcher.js')")).toEqual([])
    expect(
      dispatcherSpecifiers(`const hint = "require('./dispatcher') to load the kernel"`),
    ).toEqual([])
  })

  test('regex-literal bodies and division never mask or fake an import', () => {
    // Regression guards for the hand-rolled-mask desync classes that
    // motivated the parser pivot: a real parser resolves regex-vs-division
    // from grammar, so none of these can desync the scan.
    expect(dispatcherSpecifiers("const re = /[/*]/\nimport './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("const re = /\\/\\//; import './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("const re = /[/]/; import './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("const re = /it's/; import './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("if (cond) /[/*]/.test(s)\nimport './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("if (cond) /[//]/.test(s); import './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(
      dispatcherSpecifiers(
        "const x = a / b * 'A/B' ; import './dispatcher' ; const z = 'C'\nconst w = 'D'",
      ),
    ).toEqual(['./dispatcher'])
    // A regex whose body contains dispatcher-import text is not an import.
    expect(dispatcherSpecifiers("const re = /import '\\.\\/dispatcher'/")).toEqual([])
  })

  test('fail-closed edges: unparseable files are flagged, shebangs are inert', () => {
    // A file the parser cannot read is reported wholesale rather than
    // silently skipped.
    expect(dispatcherSpecifiers('const x = = =')).toEqual(['<unparseable module>'])
    // A shebang is comment trivia to the parser; it cannot hide an import.
    expect(dispatcherSpecifiers("#!/usr/bin/env bun\nimport './dispatcher'")).toEqual([
      './dispatcher',
    ])
  })

  test('inline type-only named imports are flagged: verbatimModuleSyntax preserves them', () => {
    // The repo's tsconfig pins `verbatimModuleSyntax: true`, under which the
    // inline type-only form is NOT erased: tsc and esbuild both emit
    // `import {} from '...'` / `export {} from '...'`, which still loads the
    // module and executes its side effects. Flagging it is fail-closed.
    expect(
      dispatcherSpecifiers("import { type T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/types'])
    expect(
      dispatcherSpecifiers(
        "import { type T, type U } from '@defrex/autobuild-hosted-dispatcher/types'",
      ),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/types'])
    expect(
      dispatcherSpecifiers(
        "import { kernel, type T } from '@defrex/autobuild-hosted-dispatcher/kernel'",
      ),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/kernel'])
    expect(
      dispatcherSpecifiers("export { type T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/types'])
  })

  test('fully type-only imports are intentionally not flagged', () => {
    // Ruled behavior: this scan enforces a runtime-load boundary — `import
    // type` / `export type ... from` are fully erased (even under this repo's
    // `verbatimModuleSyntax: true`) and cannot load the dispatcher, so
    // flagging them would be a pure false positive. The tools
    // package-boundary scanner keeps the same forms flagged on purpose (its
    // boundary is the source-convention one; a type-only import still couples
    // the test to sibling internals) — the divergence between the two
    // scanners is deliberate, not drift. (The inline `{ type T }` form is
    // different: it survives emit and IS flagged — see the dedicated fixture
    // above.)
    // Intentional narrowing: `import type` / `export type ... from` are fully
    // erased — even under this repo's `verbatimModuleSyntax: true` — and
    // cannot load the dispatcher, so the parser does not report them. (The
    // inline `{ type T }` form is different: it survives emit and IS flagged —
    // see the dedicated fixture above.)
    expect(
      dispatcherSpecifiers("import type { T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual([])
    expect(
      dispatcherSpecifiers("import type * as ns from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual([])
    expect(
      dispatcherSpecifiers("export type { T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual([])
  })
})
