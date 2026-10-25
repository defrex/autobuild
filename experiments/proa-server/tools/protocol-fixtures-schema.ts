import type { z } from 'zod'
import {
  newBuildBodySchema,
  ensureRepoBodySchema,
  leaseClaimBodySchema,
  leaseHolderBodySchema,
  newSessionBodySchema,
  eventWriteWireSchema,
  conditionalEventBodySchema,
} from '../../../packages/core/src/store/remote/protocol'
import { eventPayloadSchemas } from '../../../packages/core/src/events/payloads'
import { repositoryEventPayloadSchemas } from '../../../packages/core/src/events/repository'
import { sessionEventPayloadSchemas } from '../../../packages/core/src/events/sessions'

/** A small closed interpreter input, not an acceptance oracle or stored-event
 * schema. Unknown Zod constructs fail generation, so adding a producer check
 * cannot silently weaken a Rust write validator. Custom checks are named and
 * implemented in Rust; the source closure pins their actual TypeScript code.
 */
function node(schema: z.ZodType, path: string): unknown {
  const def = schema._zod.def as unknown as Record<string, unknown>
  const type = def.type as string
  const out: Record<string, unknown> = { type }
  if (def.error) throw new Error(`Unsupported producer error override: ${path}`)
  if (def.coerce) throw new Error(`Unsupported producer coercion: ${path}`)
  const checks = ((def.checks ?? []) as { _zod: { def: Record<string, unknown> } }[]).map(
    (check) => check._zod.def,
  )
  if (def.check) checks.unshift(def)
  if (checks.length) {
    out.checks = checks.map((raw) => {
      if (raw.check === 'custom' && path === 'turn.started.trigger.options.1')
        return { check: 'wake_exclusive_source' }
      if (
        !['min_length', 'max_length', 'number_format', 'greater_than'].includes(raw.check as string)
      )
        throw new Error(`Unsupported producer check: ${path}/${raw.check}`)
      if (raw.error) throw new Error(`Unsupported producer check error override: ${path}`)
      if (raw.check === 'number_format') {
        if (raw.format !== 'safeint')
          throw new Error(`Unsupported producer number format: ${path}/${raw.format}`)
        return { check: raw.check, format: raw.format }
      }
      if (raw.check === 'greater_than')
        return { check: raw.check, value: raw.value, inclusive: raw.inclusive }
      if (raw.check === 'min_length') return { check: raw.check, minimum: raw.minimum }
      return { check: raw.check, maximum: raw.maximum }
    })
  }
  switch (type) {
    case 'object': {
      out.shape = Object.fromEntries(
        Object.entries(def.shape as Record<string, z.ZodType>).map(([key, child]) => [
          key,
          node(child, `${path}.${key}`),
        ]),
      )
      out.strict = (def.catchall as z.ZodType)?._zod.def.type === 'never'
      if (def.catchall && !out.strict) throw new Error(`Unsupported object catchall: ${path}`)
      break
    }
    case 'nullable':
      out.inner = node(def.innerType as z.ZodType, `${path}.inner`)
      break
    case 'default':
      out.inner = node(def.innerType as z.ZodType, `${path}.inner`)
      out.value = def.defaultValue
      break
    case 'optional':
      out.inner = node(def.innerType as z.ZodType, `${path}.inner`)
      break
    case 'array':
      out.element = node(def.element as z.ZodType, `${path}.element`)
      break
    case 'record':
      if (JSON.stringify((def.keyType as z.ZodType)._zod.def) !== '{"type":"string"}')
        throw new Error(`Unsupported record key: ${path}`)
      out.value = node(def.valueType as z.ZodType, `${path}.value`)
      break
    case 'union':
      if (def.discriminator !== 'kind') throw new Error(`Unsupported producer union: ${path}`)
      out.discriminator = 'kind'
      out.options = (def.options as z.ZodType[]).map((child, index) =>
        node(child, `${path}.options.${index}`),
      )
      break
    case 'literal':
      out.values = def.values
      break
    case 'enum':
      out.values = Object.values(def.entries as Record<string, unknown>)
      break
    case 'string':
    case 'number':
    case 'boolean':
    case 'unknown':
      break
    default:
      throw new Error(`Unsupported producer schema: ${path}/${type}`)
  }
  return out
}
export function sessionWriteSchemas() {
  return Object.fromEntries(
    Object.entries(sessionEventPayloadSchemas).map(([name, schema]) => [name, node(schema, name)]),
  )
}

export const requestSchemas = {
  newBuild: newBuildBodySchema,
  ensureRepo: ensureRepoBodySchema,
  leaseClaim: leaseClaimBodySchema,
  leaseHolder: leaseHolderBodySchema,
  newSession: newSessionBodySchema,
  eventWrite: eventWriteWireSchema,
  conditionalEvent: conditionalEventBodySchema,
}
export function requestWriteSchemas() {
  return Object.fromEntries(
    Object.entries(requestSchemas).map(([name, schema]) => [name, node(schema, name)]),
  )
}

/** Every unsupported producer construct stays visible for the next porting
 * increment. Whole event schemas are excluded; no unchecked branch is accepted.
 */
export function catalogPayloadSchemas() {
  const supported: Record<string, Record<string, unknown>> = { build: {}, repository: {} }
  const unsupported: Record<string, Record<string, string>> = { build: {}, repository: {} }
  for (const [scope, schemas] of Object.entries({
    build: eventPayloadSchemas,
    repository: repositoryEventPayloadSchemas,
  })) {
    for (const [name, schema] of Object.entries(schemas)) {
      try {
        if (scope === 'build' && name === 'escalation.raised')
          throw new Error(
            'Catalog-level dispatcher/source/policyCause checks require a dedicated port',
          )
        supported[scope]![name] = node(schema, name)
      } catch (error) {
        unsupported[scope]![name] = error instanceof Error ? error.message : String(error)
      }
    }
  }
  return { supported, unsupported }
}
