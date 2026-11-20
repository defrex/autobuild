/**
 * Cold-start boundary for the command router: `main.ts` statically loads only
 * what routing, help and `--version` need. Every command implementation loads
 * inside the case that runs it, so selecting one command never evaluates the
 * dependency graph of every other handler.
 */
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'

const ROUTING_MODULES = [
  'node:fs/promises',
  'node:path',
  '../store/types',
  '../ports/workspace/git-worktree',
  './args',
  './dispatch-args',
  './dotenv',
  './help',
  './installation',
]

async function parseMain(): Promise<ts.SourceFile> {
  const path = join(import.meta.dir, 'main.ts')
  return ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true)
}

function hasValueBinding(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (clause === undefined) return true
  if (clause.isTypeOnly) return false
  if (clause.name !== undefined) return true
  const bindings = clause.namedBindings
  if (bindings === undefined) return false
  if (ts.isNamespaceImport(bindings)) return true
  return bindings.elements.some((element) => !element.isTypeOnly)
}

describe('main.ts import boundary', () => {
  test('static value imports are limited to routing modules', async () => {
    const source = await parseMain()
    const valueImports = source.statements
      .filter(ts.isImportDeclaration)
      .filter(hasValueBinding)
      .map((node) => (node.moduleSpecifier as ts.StringLiteral).text)
    const unexpected = valueImports.filter((specifier) => !ROUTING_MODULES.includes(specifier))
    expect(
      unexpected,
      'a command handler must load inside its case with `await import(...)`, not statically',
    ).toEqual([])
  })

  test('command handlers are reached only through dynamic import()', async () => {
    const source = await parseMain()
    const dynamic = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        dynamic.add(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    for (const handler of ['./dispatch', './mcp', './ticket', './watch', './init', './upgrade']) {
      expect(dynamic.has(handler), `${handler} must load inside its case`).toBe(true)
    }
  })
})
