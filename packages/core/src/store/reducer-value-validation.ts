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
  if (!Object.hasOwn(shapes.roots, name)) return false
  const root = (shapes.roots as Record<string, { acc: string }>)[name]
  return root !== undefined && matches(root.acc, value)
}
export function validateReducerValue(name: string, value: unknown): boolean {
  if (!Object.hasOwn(shapes.roots, name)) return false
  const root = (shapes.roots as Record<string, { value: string }>)[name]
  return root !== undefined && matches(root.value, value)
}
function json(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return false
    seen.add(value)
  }
  if (Array.isArray(value)) return value.every((item) => json(item, new Set(seen)))
  return (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((item) => json(item, new Set(seen)))
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

export interface ValidationFailure {
  path: string
  expected: string
}

/** Stable structural diagnostics only: persisted values never enter error text. */
export function diagnoseReducerValue(name: string, value: unknown): ValidationFailure | undefined {
  const root = Object.hasOwn(shapes.roots, name)
    ? (shapes.roots as Record<string, { value: string }>)[name]
    : undefined
  if (!root) return { path: '$', expected: 'known reducer' }
  return diagnose(root.value, value, '$')
}
function property(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}
function diagnoseJson(
  value: unknown,
  path: string,
  seen = new Set<object>(),
): ValidationFailure | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return undefined
  if (typeof value !== 'object' || seen.has(value)) return { path, expected: 'json' }
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const failure = diagnoseJson(value[i], `${path}[${i}]`, new Set(seen))
      if (failure) return failure
    }
  } else if (Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value).sort()) {
      const failure = diagnoseJson(
        (value as Record<string, unknown>)[key],
        property(path, key),
        new Set(seen),
      )
      if (failure) return failure
    }
  } else return { path, expected: 'json' }
  return undefined
}
function diagnose(id: string, value: unknown, path: string): ValidationFailure | undefined {
  if (matches(id, value)) return undefined
  const shape = schemas[id]!
  const failure = {
    path,
    expected: shape.kind === 'literal' ? JSON.stringify(shape.value) : shape.kind,
  }
  if (shape.kind === 'json') return diagnoseJson(value, path)
  if (shape.kind === 'union') {
    return (shape.items as string[])
      .map((item) => diagnose(item, value, path)!)
      .reduce((best, next) => (next.path.length > best.path.length ? next : best))
  }
  if (shape.kind === 'array' && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = diagnose(shape.items as string, value[i], `${path}[${i}]`)
      if (found) return found
    }
  }
  if (
    shape.kind === 'object' &&
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const record = value as Record<string, unknown>
    for (const [key, prop] of Object.entries(shape.props!)) {
      if (!(key in record) && prop.optional) continue
      const found = diagnose(prop.type, record[key], property(path, key))
      if (found) return found
    }
    for (const key of Object.keys(record).sort()) {
      if (Object.hasOwn(shape.props!, key)) continue
      if (!shape.index) return { path: property(path, key), expected: 'no additional property' }
      const found = diagnose(shape.index, record[key], property(path, key))
      if (found) return found
    }
  }
  return failure
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
