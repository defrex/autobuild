import { readdir, readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import ts from 'typescript'
import { repoRoot } from './git-tracked'

/**
 * Fails when a workspace test file imports into a sibling workspace package's
 * src tree via a relative specifier (`../../<pkg>/src/*`). Cross-package tests
 * import through the owning package's public or testing subpath exports — the
 * convention the AUT-407/#385/AUT-423 migration established; until now it was
 * enforced only by a one-off grep. This check is how the migration stays true.
 *
 * Scope: test files (`*.test.ts` / `*.test.tsx`, which covers `*.live.test.ts`)
 * under `packages/<pkg>/src/`. Files outside `packages/` — notably `tools/` —
 * are not scanned, and neither are production files; tools legitimately reach
 * into workspace src trees and are governed by a separate proposal.
 *
 * Specifier extraction is parser-based — the TypeScript compiler API, the same
 * approach the store-service dispatcher scan landed under AUT-436 — so
 * import-shaped text inside a line or block comment, a string literal, or a
 * template-literal interior can never produce an offender, while every import
 * position that could load a sibling package's src is still collected with an
 * exact AST line number. Coverage relative to the raw-text regexes this
 * replaces is enumerated precisely in `collectSpecifiers`' doc comment below —
 * including a deliberate `require.call/apply` widening (the regexes matched no
 * such form) and a deliberate narrowing (leading-literal concatenation
 * specifiers, which the regexes did match). A file that does not parse fails
 * closed: it yields a
 * single `<unparseable module>` sentinel violation rather than being silently
 * skipped, so ambiguity always errs toward flagging. This aligns the guard
 * with the store-service dispatcher scan's approach, with one deliberate
 * divergence: fully type-only forms (`import type …`, `export type … from`)
 * remain flagged here because the raw-text regexes this replaces flagged them,
 * and changing which imports the guard forbids is out of scope.
 */

export interface ScannedFile {
  /** Repo-root-relative, POSIX separators. */
  path: string
  contents: string
}

export interface Violation {
  path: string
  line: number
  specifier: string
  fromPackage: string
  toPackage: string
}

const UNPARSEABLE_MODULE = '<unparseable module>'

interface CollectedSpecifier {
  specifier: string
  line: number
}

/**
 * Expressions that denote `require` itself: the bare identifier, or a property
 * access whose name is `require` (any receiver — `module.require`,
 * `globalThis.require`, ...). Matching any receiver is fail-closed and
 * harmless: only relative specifiers that resolve into a sibling src tree are
 * ever reported. The same shape the store-service dispatcher scan uses.
 */
const isRequireishExpression = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === 'require') ||
  (ts.isPropertyAccessExpression(node) && node.name.text === 'require')

/**
 * Parser-based specifier extraction: every string-literal module specifier at
 * a real import position, with its 1-based line. Collection is by specifier
 * position: a string literal is collected only when it sits in the exact
 * specifier slot of a collected call/import — never merely somewhere inside a
 * call's argument subtree — so an option-bag value, a second argument, or a
 * computed argument such as `require(path.join(__dirname, './x'))` is not an
 * offender, and a nested collected call (`require(require('./x'))`) is
 * collected exactly once by its own visit.
 *
 * Pinned specifier positions (a string is collected iff it is a StringLiteral
 * at one of these slots):
 *
 * - import declarations: `moduleSpecifier` — including side-effect `import '…'`
 *   and fully type-only `import type …` (see the header comment);
 * - export declarations with a module specifier (`export … from`, including
 *   type-only re-exports): `moduleSpecifier`;
 * - `import x = require('…')`: the external-module-reference's expression;
 * - dynamic `import(…)` and require-ish calls (`require(…)`, `x.require(…)`,
 *   `new require(…)`): `arguments[0]`;
 * - `require.call(recv, '…')`: `arguments[1]`;
 * - `require.apply(recv, ['…', …])`: element 0 of the `arguments[1]` array
 *   literal;
 * - type-position `import(…)` — `import('…').Type` and `typeof import('…')`:
 *   the import type node's string-literal argument (the raw-text regexes
 *   matched the import(…) text wherever it appeared, so type nodes stay
 *   flagged too).
 *
 * Coverage relative to the four raw-text regexes this replaces (`from '…'`,
 * `import '…'`, `import(…)`, `require('…')`), with the deliberate movements
 * named rather than papered over:
 *
 * - Deliberate widening — the regexes matched none of these forms:
 *   `require.call/apply(…)` at the pinned positions. The originating plan's
 *   "no widening" out-of-scope line governed *policy* — which imports are
 *   forbidden at the boundary — and that policy is unchanged; form coverage is
 *   a separate axis, and it does widen here for call/apply.
 * - Narrowings vs the regexes: a leading-literal concatenation specifier
 *   (`require('./x' + suffix)`, `import('./x' + suffix)` — the regexes matched
 *   the leading literal, which is not a specifier literal and is no longer
 *   collected), and regex text-shaped false positives such as a
 *   `.import('./x')` method call, whose text the `\bimport\s*\(\s*['"]`
 *   pattern matched. (A `.from('./x')` method call was never flagged: the
 *   `from` regex needs a quote directly after `from`.)
 * - Narrowings vs the pre-fix argument-subtree walk only, not vs the regexes —
 *   the regexes never matched any apply form at all: `require.apply` array
 *   elements past the first.
 * - Pre-existing non-coverage, preserved unchanged: template-literal
 *   specifiers, matched by neither the regexes nor the pre-fix walk.
 *
 * Because specifiers are scoped to import positions, text inside a comment,
 * a string literal, or a template-literal interior can never yield a
 * specifier — but an interpolation *expression* is real code, so a dynamic
 * import inside `${…}` is still flagged.
 *
 * Fail-closed: a file with a category-Error parse diagnostic yields the
 * `<unparseable module>` sentinel (line 1) instead of being skipped. The gate
 * parses with the file's script kind, so valid JSX in a `.test.tsx` is not a
 * diagnostic and cannot trip the sentinel.
 */
function collectSpecifiers(
  contents: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): CollectedSpecifier[] {
  // The gate must parse with the same script kind as the extractor below:
  // without a `.tsx` fileName the transpiler parses JSX as plain TS and a
  // valid `.test.tsx` would fail closed as `<unparseable module>`.
  const { diagnostics } = ts.transpileModule(contents, {
    reportDiagnostics: true,
    fileName: scriptKind === ts.ScriptKind.TSX ? 'module.tsx' : 'module.ts',
  })
  if ((diagnostics ?? []).some((d) => d.category === ts.DiagnosticCategory.Error)) {
    return [{ specifier: UNPARSEABLE_MODULE, line: 1 }]
  }
  const sourceFile = ts.createSourceFile(
    'module.ts',
    contents,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const specifiers: CollectedSpecifier[] = []
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

  // Specifier-position collection: collect the string literal sitting in a
  // collected call's specifier slot, never the surrounding argument subtree.
  // A non-string argument (including a template literal — the raw-text regexes
  // this scanner replaces never matched past a backtick) yields nothing.
  const stringLiteralAt = (expression: ts.Expression | undefined): ts.StringLiteral | undefined =>
    expression !== undefined && ts.isStringLiteral(expression) ? expression : undefined
  const collectSpecifierAt = (expression: ts.Expression | undefined): void => {
    const literal = stringLiteralAt(expression)
    if (literal === undefined) return
    specifiers.push({ specifier: literal.text, line: lineOf(literal) })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // No `importClause.isTypeOnly` filter: type-only forms stay flagged
      // (documented divergence from the store-service scanner).
      specifiers.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node.moduleSpecifier),
      })
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(node.moduleSpecifier),
      })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      // `import x = require('…')` — no type-only erasure exists for it.
      specifiers.push({
        specifier: node.moduleReference.expression.text,
        line: lineOf(node.moduleReference.expression),
      })
    } else if (ts.isImportTypeNode(node)) {
      // Type-position `import(…)`: `import('…').Type` and `typeof import('…')`
      // parse as an ImportTypeNode, not a call, and the raw-text regexes this
      // scanner replaces matched the import(…) text wherever it appeared — so
      // the type node's string-literal argument stays flagged. Template-literal
      // type arguments were never matched and are not collected.
      const { argument } = node
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        specifiers.push({ specifier: argument.literal.text, line: lineOf(argument.literal) })
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // Dynamic `import(…)`: only the specifier slot, `arguments[0]`.
        collectSpecifierAt(node.arguments[0])
      } else if (isRequireishExpression(node.expression)) {
        collectSpecifierAt(node.arguments[0])
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'call' || node.expression.name.text === 'apply') &&
        isRequireishExpression(node.expression.expression)
      ) {
        // `require.call(recv, '…')`: the specifier is the first argument after
        // the receiver. `require.apply(recv, ['…', …])`: element 0 of the
        // arguments array literal — a deliberate widening over the regexes,
        // which never matched any call/apply form; elements past the first
        // are not specifiers and are not collected (a narrowing vs the pre-fix
        // subtree walk only).
        const argsOrReceiver = node.arguments[1]
        if (node.expression.name.text === 'apply') {
          // Only an array-literal second argument carries a specifier, and
          // only its element 0 (narrow past a SpreadElement: not an array
          // literal, nothing collected).
          if (argsOrReceiver !== undefined && ts.isArrayLiteralExpression(argsOrReceiver)) {
            collectSpecifierAt(argsOrReceiver.elements[0])
          }
        } else {
          collectSpecifierAt(argsOrReceiver)
        }
      }
    } else if (ts.isNewExpression(node) && isRequireishExpression(node.expression)) {
      // `new require(...)`: only the specifier slot, `arguments[0]`.
      collectSpecifierAt(node.arguments?.[0])
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return specifiers
}

const scriptKindOf = (path: string): ts.ScriptKind =>
  path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS

const ownsSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../')

const owningPackageOf = (path: string, packages: readonly string[]): string | undefined =>
  packages.find((pkg) => path.startsWith(`packages/${pkg}/`))

const srcPrefixOf = (pkg: string): string => `packages/${pkg}/src`

/**
 * True when the relative specifier, resolved against the importing file's
 * directory, lands inside a different workspace package's src tree.
 */
export function resolvesIntoSiblingSrc(
  filePath: string,
  specifier: string,
  packages: readonly string[],
): { toPackage: string } | undefined {
  const fromPackage = owningPackageOf(filePath, packages)
  if (fromPackage === undefined) return undefined
  const resolved = posix.normalize(posix.join(posix.dirname(filePath), specifier))
  for (const pkg of packages) {
    if (pkg === fromPackage) continue
    const prefix = srcPrefixOf(pkg)
    if (resolved === prefix || resolved.startsWith(`${prefix}/`)) {
      return { toPackage: pkg }
    }
  }
  return undefined
}

/**
 * The pure scanner: every supplied file in order. Specifiers carry AST
 * positions, so a violation always reports the line a reader can find. An
 * unparseable file is reported whole as a `<unparseable module>` sentinel
 * violation (fail-closed) rather than being silently skipped; files outside
 * every workspace package remain ungoverned by this guard, sentinel included.
 */
export function findBoundaryViolations(
  files: Iterable<ScannedFile>,
  packages: readonly string[],
): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    const fromPackage = owningPackageOf(file.path, packages)
    for (const { specifier, line } of collectSpecifiers(file.contents, scriptKindOf(file.path))) {
      if (specifier === UNPARSEABLE_MODULE) {
        if (fromPackage !== undefined) {
          // Pinned sentinel shape: an unparseable scanned file yields exactly
          // one full Violation — { path: file.path, line: 1, specifier:
          // '<unparseable module>', fromPackage, toPackage: '<unknown>' }.
          // fromPackage is owningPackageOf(file.path, packages): files outside
          // every workspace package are never reported, sentinel included.
          // toPackage is the literal '<unknown>' because an unparseable file
          // names no target — the whole file is the offender and parsing it is
          // the fix. runPackageBoundaryCheck is unchanged and prints the target
          // raw through its existing UNPARSEABLE_MODULE special case, so
          // srcPrefixOf never sees the sentinel.
          violations.push({
            path: file.path,
            line,
            specifier,
            fromPackage,
            toPackage: '<unknown>',
          })
        }
        continue
      }
      if (!ownsSpecifier(specifier)) continue
      const target = resolvesIntoSiblingSrc(file.path, specifier, packages)
      if (target === undefined) continue
      violations.push({
        path: file.path,
        line,
        specifier,
        fromPackage: fromPackage!,
        toPackage: target.toPackage,
      })
    }
  }
  return violations
}

/** Scope of the guard: test files under a workspace package's src tree. */
export function isScannedTestFile(path: string, packages: readonly string[]): boolean {
  if (!/\.test\.(ts|tsx)$/.test(path)) return false
  return packages.some((pkg) => path.startsWith(`packages/${pkg}/src/`))
}

export interface PackageBoundaryCheckEnvironment {
  /** Workspace package directory names. Rejecting is fatal: see `runPackageBoundaryCheck`. */
  listWorkspacePackages: () => Promise<readonly string[]>
  /** Every file under `packages/`, repo-root-relative, recursively. Rejecting is fatal. */
  listFilesUnderPackages: () => Promise<readonly string[]>
  readFile: (path: string) => Promise<Uint8Array>
}

export interface ScanReport {
  violations: Violation[]
  scanned: number
}

/**
 * Reads every collected test file from the working tree — walking the
 * filesystem rather than asking git means untracked files are scanned too, so
 * an in-progress edit is caught before it is ever committed.
 */
export async function scanWorkspace(env: PackageBoundaryCheckEnvironment): Promise<ScanReport> {
  const packages = await env.listWorkspacePackages()
  const testPaths = (await env.listFilesUnderPackages()).filter((path) =>
    isScannedTestFile(path, packages),
  )
  const files: ScannedFile[] = []
  for (const path of testPaths) {
    files.push({ path, contents: new TextDecoder().decode(await env.readFile(path)) })
  }
  return { violations: findBoundaryViolations(files, packages), scanned: files.length }
}

export interface PackageBoundaryCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

const convention =
  'Cross-package tests import through the owning package’s public or testing ' +
  'subpath exports, never a relative ../../<pkg>/src/* specifier into a ' +
  'sibling package’s src tree.'

export async function runPackageBoundaryCheck(
  env: PackageBoundaryCheckEnvironment,
  output: PackageBoundaryCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let report: ScanReport
  try {
    report = await scanWorkspace(env)
  } catch (error) {
    // A check that cannot enumerate or read must never report success.
    const message = error instanceof Error ? error.message : String(error)
    output.stderr(`Could not check the package boundary across test files: ${message}\n`)
    return 1
  }

  if (report.violations.length === 0) {
    output.stdout(
      `Package boundary check: ${report.scanned} test files scanned, no cross-package src imports.\n`,
    )
    return 0
  }

  for (const violation of report.violations) {
    // A sentinel violation names no target package, so it is printed raw;
    // every real violation names the sibling src prefix it reaches.
    const target =
      violation.specifier === UNPARSEABLE_MODULE ? '<unknown>' : srcPrefixOf(violation.toPackage)
    output.stdout(
      `${violation.path}:${violation.line}: specifier '${violation.specifier}' reaches ` +
        `${target} from ${violation.fromPackage} tests\n`,
    )
  }
  output.stderr(`${convention}\n${report.violations.length} violation(s) found.\n`)
  return 1
}

// `dirent.path` (a Bun/Node 20+ addition) would make this a one-liner, but the
// explicit prefix keeps the walk working on the pinned TypeScript lib too.
async function walkFiles(root: string, prefix: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      // Dependencies and metadata are never workspace test files.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      paths.push(...(await walkFiles(`${root}/${entry.name}`, relative)))
    } else if (entry.isFile()) {
      paths.push(relative)
    }
  }
  return paths
}

export const realEnvironment: PackageBoundaryCheckEnvironment = {
  listWorkspacePackages: async () => {
    const entries = await readdir(`${repoRoot}packages`, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  },
  listFilesUnderPackages: () => walkFiles(`${repoRoot}packages`, 'packages'),
  readFile: (path) => readFile(`${repoRoot}${path}`),
}

if (import.meta.main) {
  process.exitCode = await runPackageBoundaryCheck(realEnvironment)
}
