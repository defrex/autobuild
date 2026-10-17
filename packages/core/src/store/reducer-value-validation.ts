import type { JsonValue } from './reducer-values'
import shapes from './reducer-value-shapes.json'

type Shape = {
  kind: string
  value?: unknown
  items?: string | string[]
  props?: Record<string, { type: string; optional: boolean }>
  index?: string
}
const schemas: Record<string, Shape> = shapes.schemas

/** Generated structural shapes include nested event payload unions, records,
 * optional fields and literal discriminants. No accumulator is trusted merely
 * because finish() happens to accept it. */
export function validateAccumulator(name: string, value: unknown): boolean {
  const root = (shapes.roots as Record<string, { acc: string }>)[name]
  return root !== undefined && matches(root.acc, value)
}
export function validateReducerValue(name: string, value: unknown): boolean {
  const root = (shapes.roots as Record<string, { value: string }>)[name]
  return root !== undefined && matches(root.value, value)
}
function json(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(json)
  return (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(json)
  )
}
function matches(id: string, value: unknown): boolean {
  const shape = schemas[id]!
  switch (shape.kind) {
    case 'json':
      return json(value)
    case 'undefined':
      return value === undefined
    case 'literal':
      return value === shape.value
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'union':
      return (shape.items as string[]).some((item) => matches(item, value))
    case 'array':
      return Array.isArray(value) && value.every((item) => matches(shape.items as string, item))
    case 'object': {
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      )
        return false
      const record = value as Record<string, unknown>
      for (const [key, prop] of Object.entries(shape.props!)) {
        if (!(key in record) && prop.optional) continue
        if (!matches(prop.type, record[key])) return false
      }
      return Object.keys(record).every(
        (key) =>
          Object.hasOwn(shape.props!, key) ||
          (shape.index !== undefined && matches(shape.index, record[key])),
      )
    }
    default:
      return false
  }
}

/** Existing optional object fields keep their ordinary JSON omission semantics.
 * Collections, functions, nonfinite numbers and undefined array entries cannot
 * silently become a different public contract during JSON serialization. */
export function encodeReducerValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value as JsonValue
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(encodeReducerValue)
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, encodeReducerValue(item)]),
    )
  throw new Error('reducer finished value is not plain JSON')
}
