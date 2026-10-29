import type { JsonValue } from './reducer-values'
import shapes from './reducer-value-shapes.json'

type Shape = {
  kind: string
  value?: unknown
  items?: string | string[]
  props?: Record<string, { type: string; optional: boolean }>
  index?: string
}
export const REDUCER_VALUE_CONTRACT_IDENTITY = new Bun.CryptoHasher('sha256')
  .update(JSON.stringify(shapes))
  .digest('hex')
const schemas: Record<string, Shape> = shapes.schemas

/** A finished-value shape catalog: this build's generated one, or a frozen
 * catalog from a published release line. */
export interface ReducerValueCatalog {
  roots: Record<string, { value: string }>
  schemas: Record<string, Shape>
}

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
function matches(id: string, value: unknown, table = schemas): boolean {
  const shape = table[id]!
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
      return (shape.items as string[]).some((item) => matches(item, value, table))
    case 'array':
      return (
        Array.isArray(value) && value.every((item) => matches(shape.items as string, item, table))
      )
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
        if (!matches(prop.type, record[key], table)) return false
      }
      return Object.keys(record).every(
        (key) =>
          Object.hasOwn(shape.props!, key) ||
          (shape.index !== undefined && matches(shape.index, record[key], table)),
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
  const failure = diagnose(root.value, value, '$', 0)
  return failure ? { path: failure.path, expected: failure.expected } : undefined
}
function property(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}
type Diagnostic = ValidationFailure & { depth: number }
function diagnoseJson(
  value: unknown,
  path: string,
  depth: number,
  seen = new Set<object>(),
): Diagnostic | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return undefined
  if (typeof value !== 'object' || seen.has(value)) return { path, expected: 'json', depth }
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const failure = diagnoseJson(value[i], `${path}[${i}]`, depth + 1, new Set(seen))
      if (failure) return failure
    }
  } else if (Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value).sort()) {
      const failure = diagnoseJson(
        (value as Record<string, unknown>)[key],
        property(path, key),
        depth + 1,
        new Set(seen),
      )
      if (failure) return failure
    }
  } else return { path, expected: 'json', depth }
  return undefined
}
function diagnose(id: string, value: unknown, path: string, depth: number): Diagnostic | undefined {
  if (matches(id, value)) return undefined
  const shape = schemas[id]!
  const failure = {
    path,
    depth,
    expected: shape.kind === 'literal' ? JSON.stringify(shape.value) : shape.kind,
  }
  if (shape.kind === 'json') return diagnoseJson(value, path, depth)
  if (shape.kind === 'union') {
    return (shape.items as string[])
      .map((item) => diagnose(item, value, path, depth)!)
      .reduce((best, next) => (next.depth > best.depth ? next : best))
  }
  if (shape.kind === 'array' && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = diagnose(shape.items as string, value[i], `${path}[${i}]`, depth + 1)
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
      const found = diagnose(prop.type, record[key], property(path, key), depth + 1)
      if (found) return found
    }
    for (const key of Object.keys(record).sort()) {
      if (Object.hasOwn(shape.props!, key)) continue
      if (!shape.index)
        return { path: property(path, key), expected: 'no additional property', depth: depth + 1 }
      const found = diagnose(shape.index, record[key], property(path, key), depth + 1)
      if (found) return found
    }
  }
  return failure
}

type Projected = { value: unknown; dropped: number }
type Unprojectable = Diagnostic
type Projection = Projected | Unprojectable
// Plugin consumers may compile without strict narrowing; `in` guards narrow everywhere.
const failed = (result: Projection): result is Unprojectable => 'path' in result

/** Project a value onto a catalog's shape, dropping object properties the shape
 * does not know. Additive server fields then reach older readers as the value
 * they were built for, while a missing field or unknown variant still fails.
 * Among union members, the one dropping the fewest properties wins. */
function project(
  table: Record<string, Shape>,
  id: string,
  value: unknown,
  path: string,
  depth: number,
): Projection {
  if (matches(id, value, table)) return { value, dropped: 0 }
  const shape = table[id]!
  const failure: Unprojectable = {
    path,
    depth,
    expected: shape.kind === 'literal' ? JSON.stringify(shape.value) : shape.kind,
  }
  if (shape.kind === 'union') {
    let best: Projection | undefined
    for (const item of shape.items as string[]) {
      const next = project(table, item, value, path, depth)
      if (!failed(next)) {
        if (!best || failed(best) || next.dropped < best.dropped) best = next
      } else if (!best || (failed(best) && next.depth > best.depth)) best = next
    }
    return best ?? failure
  }
  if (shape.kind === 'array' && Array.isArray(value)) {
    const items: unknown[] = []
    let dropped = 0
    for (let i = 0; i < value.length; i++) {
      const next = project(table, shape.items as string, value[i], `${path}[${i}]`, depth + 1)
      if (failed(next)) return next
      items.push(next.value)
      dropped += next.dropped
    }
    return { value: items, dropped }
  }
  if (
    shape.kind === 'object' &&
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    let dropped = 0
    for (const [key, prop] of Object.entries(shape.props!)) {
      if (!(key in record) && prop.optional) continue
      const next = project(table, prop.type, record[key], property(path, key), depth + 1)
      if (failed(next)) return next
      if (key in record) out[key] = next.value
      dropped += next.dropped
    }
    for (const key of Object.keys(record).sort()) {
      if (Object.hasOwn(shape.props!, key)) continue
      if (!shape.index) {
        dropped += 1
        continue
      }
      const next = project(table, shape.index, record[key], property(path, key), depth + 1)
      if (failed(next)) return next
      out[key] = next.value
      dropped += next.dropped
    }
    return { value: out, dropped }
  }
  return failure
}

/** The reader-side contract for a server's canonical answer: the value as this
 * reader's shape can represent it, or a structural diagnostic. Reducer versions
 * are cache identities, not compatibility gates. */
export function projectReducerValue(
  name: string,
  value: unknown,
  catalog: ReducerValueCatalog = shapes,
): { value: unknown } | ValidationFailure {
  const root = Object.hasOwn(catalog.roots, name) ? catalog.roots[name] : undefined
  if (!root) return { path: '$', expected: 'known reducer' }
  const result = project(catalog.schemas, root.value, value, '$', 0)
  return failed(result) ? { path: result.path, expected: result.expected } : { value: result.value }
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
