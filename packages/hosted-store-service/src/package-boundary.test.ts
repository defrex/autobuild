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
 */
const DISPATCHER_SPECIFIER =
  /^(?:\.\/dispatcher(?:$|[./]))|(?:^@defrex\/autobuild-hosted-dispatcher)/

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
 * flagged), and `require('...')` (defensively; the package is ESM and has no
 * require today). A scan that missed side-effect or dynamic forms would let
 * the dispatcher's kernel/provider closure silently reintroduce itself.
 *
 * Intentionally not flagged: the fully type-only forms `import type { T } from
 * '...'` and `export type { T } from '...'` — both are erased even under
 * `verbatimModuleSyntax` and cannot load the dispatcher.
 *
 * Fail-closed edges: a file that fails to parse (syntactic errors) yields the
 * `<unparseable module>` sentinel so the tree walk reports the whole file as
 * an offender rather than skipping it; ambiguity errs toward flagging.
 */
const UNPARSEABLE_MODULE = '<unparseable module>'

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
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // `import type ...` is fully erased; every other import declaration
      // (including `import { type T } ...`) survives verbatimModuleSyntax
      // emit and loads the module.
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
        if (argument && ts.isStringLiteral(argument)) {
          if (DISPATCHER_SPECIFIER.test(argument.text)) specifiers.push(argument.text)
        } else if (argument) {
          // Dynamic import with a template-literal specifier (or any argument
          // expression containing one): the raw source text between the
          // backticks is reported, interpolation included (e.g.
          // `@defrex/autobuild-hosted-dispatcher/${name}`), so the
          // dispatcher-prefix check sees exactly what the source names. The
          // parser keeps this scoped to real import positions — a template
          // literal elsewhere in the file is never an import.
          const visitTemplates = (n: ts.Node): void => {
            if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
              const raw = n.getText(sourceFile).slice(1, -1)
              if (DISPATCHER_SPECIFIER.test(raw)) specifiers.push(raw)
            }
            n.forEachChild(visitTemplates)
          }
          visitTemplates(argument)
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteral(argument) && DISPATCHER_SPECIFIER.test(argument.text)) {
          specifiers.push(argument.text)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return specifiers
}

describe('hosted-store-service package boundary', () => {
  test('manifest has no dispatcher export and no dispatcher or provider dependency', async () => {
    const manifest = await readManifest()
    expect(Object.keys(manifest.exports ?? {})).not.toContain('./dispatcher')
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]
    expect(dependencyNames.filter((name) => name.includes('hosted-dispatcher'))).toEqual([])
    expect(
      dependencyNames.filter(
        (name) => name === '@vercel/sandbox' || name.startsWith('@defrex/autobuild-'),
      ),
    ).toEqual(['@defrex/autobuild-postgres-store'])
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

    // Limitation, by design: a dynamic import whose specifier is a bare
    // variable (`import(pkgVar)`) or whose text is reshaped by interpolation
    // (e.g. `import(`./dispatch${kind}`)`) cannot be resolved statically
    // and stays outside this scan's claimed reach.
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
