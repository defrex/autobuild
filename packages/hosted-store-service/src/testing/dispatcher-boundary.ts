import ts from 'typescript'

/** Runtime-load boundary, deliberately distinct from tools/package-boundary-check.ts:
 * erased type imports do not load modules; inline type bindings do. Dynamic
 * imports collect the first argument subtree, require forms all arguments.
 * Templates are collected as raw text, and parse errors fail closed.
 * Bare variables, require.bind and element-access callees are outside the scan.
 */
const DISPATCHER_SPECIFIER =
  /^(?:\.\/dispatcher(?:$|[./]))|(?:^@defrex\/autobuild-hosted-dispatcher(?:$|[^A-Za-z0-9._-]))/

const UNPARSEABLE_MODULE = '<unparseable module>'

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
        // literal. Deliberate — see the collection-semantics ruling in the
        // scanner doc comment above.
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

export function dispatcherDependencyNames(names: readonly string[]): string[] {
  return names.filter((name) => DISPATCHER_SPECIFIER.test(name))
}
