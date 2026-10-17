import ts from 'typescript'
import { REDUCERS } from '../packages/core/src/kernel/reducer-registry'

const covers = new Set(Object.values(REDUCERS).flatMap((entry) => [...entry.covers]))
const rawMethods = new Set(['getEvents', 'getRepoEvents', 'getRepoStateEvents'])
export interface ReadBoundary {
  key: string
  kind: 'raw' | 'reduction'
  operation: string
  cursor: boolean
  line: number
}
export interface ReadException {
  reason: string
  kind: ReadBoundary['kind']
  cursor?: boolean
}

/** Stable source/function identities; no directory exemptions. Import and local
 * aliases are resolved before classifying calls, including bound raw readers. */
export function readBoundaries(file: string, source: string): ReadBoundary[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const aliases = new Map<string, ts.Expression | string>()
  const localReducers = new Set<string>()
  function declarations(node: ts.Node) {
    if (ts.isImportSpecifier(node))
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      aliases.set(node.name.text, node.initializer)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      /defineReducer$/.test(node.initializer.expression.getText(tree))
    )
      localReducers.add(node.name.text)
    ts.forEachChild(node, declarations)
  }
  declarations(tree)
  function target(expression: ts.Expression, seen = new Set<string>()): string {
    if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression))
      return target(expression.expression, seen)
    if (ts.isIdentifier(expression)) {
      if (localReducers.has(expression.text)) return `@reducer:${expression.text}`
      if (seen.has(expression.text)) return expression.text
      seen.add(expression.text)
      const alias = aliases.get(expression.text)
      return typeof alias === 'string' ? alias : alias ? target(alias, seen) : expression.text
    }
    if (ts.isPropertyAccessExpression(expression))
      return `${target(expression.expression, seen)}.${expression.name.text}`
    if (ts.isCallExpression(expression)) {
      const name = target(expression.expression, seen)
      return name.endsWith('.bind') ? name.slice(0, -5) : `${name}()`
    }
    return ''
  }
  function owner(node: ts.Node): string {
    const names: string[] = []
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (
        (ts.isFunctionDeclaration(current) ||
          ts.isMethodDeclaration(current) ||
          ts.isClassDeclaration(current)) &&
        current.name
      )
        names.unshift(current.name.getText(tree))
      if (
        ts.isVariableDeclaration(current) &&
        current.initializer &&
        (ts.isArrowFunction(current.initializer) ||
          ts.isFunctionExpression(current.initializer) ||
          (ts.isCallExpression(current.initializer) &&
            current.initializer.expression.getText(tree) === 'defineReducer'))
      )
        names.unshift(current.name.getText(tree))
    }
    return names.join('/') || '<module>'
  }
  const output: ReadBoundary[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = target(node.expression)
      const operation = name.split('.').at(-1) ?? ''
      const raw = rawMethods.has(operation)
      const reducer =
        covers.has(name) ||
        ((operation === 'reduce' || operation === 'advance' || operation === 'finish') &&
          (/(?:Reducer|reducer)(?:\(\))?\./.test(name) || name.startsWith('@reducer:')))
      if (raw || reducer)
        output.push({
          key: `${file}::${owner(node)}::${operation}`,
          kind: raw ? 'raw' : 'reduction',
          operation,
          cursor: node.arguments.length > 1,
          line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return output
}
export function checkReadBoundaries(
  boundaries: ReadBoundary[],
  exceptions: Record<string, ReadException>,
  stale = true,
): string[] {
  const used = new Set<string>()
  const errors: string[] = []
  for (const boundary of boundaries) {
    const exception = exceptions[boundary.key]
    if (
      !exception ||
      exception.kind !== boundary.kind ||
      !exception.reason.trim() ||
      (exception.cursor && !boundary.cursor)
    )
      errors.push(
        `${boundary.key}:${boundary.line}: ${boundary.kind} must use persisted reduced reads or a documented event-consumption exception`,
      )
    else used.add(boundary.key)
  }
  if (stale)
    for (const key of Object.keys(exceptions))
      if (!used.has(key)) errors.push(`stale persisted-read exception: ${key}`)
  return errors
}
