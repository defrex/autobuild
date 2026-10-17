/** Regenerate structural accumulator validators after changing reducer types:
 * bun tools/reducer-value-shapes.ts [--check]
 * This uses declared types, including event payload unions, rather than learning
 * a permissive schema from empty accumulators or example logs. */
import ts from 'typescript'
import { readFile, writeFile } from 'node:fs/promises'

interface Shape {
  kind: string
  value?: unknown
  items?: string | string[]
  props?: Record<string, { type: string; optional: boolean }>
  index?: string
  reason?: string
}
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
const program = ts.createProgram(parsed.fileNames, parsed.options)
const checker = program.getTypeChecker()
const file = program.getSourceFile(`${process.cwd()}/packages/core/src/kernel/reducer-registry.ts`)!
const schemas: Record<string, Shape> = {}
const roots: Record<string, { acc: string; value: string }> = {}
const ids = new Map<ts.Type, string>()
function schema(type: ts.Type): string {
  const prior = ids.get(type)
  if (prior !== undefined) return prior
  const id = String(ids.size)
  ids.set(type, id)
  schemas[id] = { kind: 'pending' }
  let shape: Shape
  const flags = ts.TypeFlags
  if (type.flags & (flags.Any | flags.Unknown)) shape = { kind: 'json' }
  else if (type.flags & (flags.Undefined | flags.Void)) shape = { kind: 'undefined' }
  else if (type.flags & flags.Null) shape = { kind: 'literal', value: null }
  else if (type.isLiteral()) shape = { kind: 'literal', value: type.value }
  else if (type.flags & flags.BooleanLiteral)
    shape = { kind: 'literal', value: checker.typeToString(type) === 'true' }
  else if (type.flags & flags.StringLike) shape = { kind: 'string' }
  else if (type.flags & flags.NumberLike) shape = { kind: 'number' }
  else if (type.flags & flags.Boolean) shape = { kind: 'boolean' }
  else if (type.isUnion()) shape = { kind: 'union', items: type.types.map(schema) }
  else if (checker.isArrayType(type) || checker.isTupleType(type))
    shape = { kind: 'array', items: schema(checker.getIndexTypeOfType(type, ts.IndexKind.Number)!) }
  else if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length)
    shape = { kind: 'excluded', reason: 'function' }
  else if (/^(Map|Set|ReadonlyMap|ReadonlySet)</.test(checker.typeToString(type)))
    shape = { kind: 'excluded', reason: 'collection' }
  else {
    const props: NonNullable<Shape['props']> = {}
    for (const property of checker.getPropertiesOfType(type))
      props[property.name] = {
        type: schema(
          checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? file),
        ),
        optional: !!(property.flags & ts.SymbolFlags.Optional),
      }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String)
    shape = { kind: 'object', props, ...(index ? { index: schema(index) } : {}) }
  }
  schemas[id] = shape
  return id
}
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(file) === 'REGISTERED' &&
    node.initializer &&
    ts.isObjectLiteralExpression(node.initializer)
  ) {
    for (const property of node.initializer.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer))
        continue
      const reducer = property.initializer.properties.find(
        (prop) => prop.name?.getText(file) === 'reducer',
      )
      if (!reducer || !ts.isPropertyAssignment(reducer))
        throw new Error('registry entry lacks reducer')
      const type = checker.getTypeAtLocation(reducer.initializer)
      const result = (name: string) => {
        const method = checker.getTypeOfSymbolAtLocation(
          type.getProperty(name)!,
          reducer.initializer,
        )
        return checker.getReturnTypeOfSignature(
          checker.getSignaturesOfType(method, ts.SignatureKind.Call)[0]!,
        )
      }
      roots[property.name.getText(file)] = {
        acc: schema(result('initial')),
        value: schema(result('finish')),
      }
    }
  }
  ts.forEachChild(node, visit)
}
visit(file)
const target = 'packages/core/src/store/reducer-value-shapes.json'
const output = `${JSON.stringify({ roots, schemas }, null, 2)}\n`
if (process.argv.includes('--check')) {
  if (
    JSON.stringify(JSON.parse(await readFile(target, 'utf8'))) !==
    JSON.stringify({ roots, schemas })
  )
    throw new Error(`stale ${target}; run bun tools/reducer-value-shapes.ts`)
} else await writeFile(target, output)
