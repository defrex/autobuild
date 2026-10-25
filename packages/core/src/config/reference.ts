import type { z } from 'zod'
import { referenceMetadata, type ReferenceMetadata } from './reference-metadata'
import { BUILTIN_WORKSPACE_PROVIDER_CONFIG, configRootSchema } from './schema'
import { BUILD_OWNED_CONFIG_PATHS, CONFIG_RELOAD_CLASSIFICATION } from './live'

/** Zod 4 input adapter. Unsupported nodes/checks fail closed at their TOML path. */
interface Definition {
  type: string
  innerType?: z.ZodType
  in?: z.ZodType
  element?: z.ZodType
  shape?: Record<string, z.ZodType>
  catchall?: z.ZodType
  options?: z.ZodType[]
  entries?: Record<string, string>
  values?: unknown[]
  defaultValue?: unknown
  checks?: { _zod: { def: Check } }[]
}
interface Check {
  check: string
  format?: string
  value?: number
  minimum?: number
  maximum?: number
  length?: number
  inclusive?: boolean
  pattern?: RegExp
  error?: () => string
}
function definition(schema: z.ZodType): Definition {
  return schema._zod.def as unknown as Definition
}
function fail(path: string, message: string): never {
  throw new Error(`Configuration reference ${path}: ${message}`)
}
function metadata(schema: z.ZodType, path: string): ReferenceMetadata {
  const result = referenceMetadata(schema) ?? {}
  for (const [key, value] of Object.entries(result)) {
    if (
      !['description', 'constraints', 'required', 'examples', 'structure', 'default'].includes(key)
    )
      fail(path, `unknown metadata ${key}`)
    if (
      ['description', 'constraints', 'required', 'default'].includes(key) &&
      (typeof value !== 'string' || !value.trim())
    )
      fail(path, `blank or malformed ${key}`)
  }
  if (
    result.examples !== undefined &&
    (!Array.isArray(result.examples) ||
      result.examples.some((v) => typeof v !== 'string' || !v.trim()))
  )
    fail(path, 'malformed examples')
  if (result.structure !== undefined) {
    const structure = result.structure
    if (!structure || typeof structure !== 'object') fail(path, 'malformed structure metadata')
    const allowed =
      structure.kind === 'map'
        ? ['kind', 'value', 'keys']
        : structure.kind === 'steps'
          ? ['kind', 'steps', 'table', 'afterReconcile']
          : []
    if (!allowed.length) fail(path, 'unsupported structure descriptor')
    for (const key of Object.keys(structure))
      if (!allowed.includes(key)) fail(path, `unknown structure metadata ${key}`)
    const isSchema = (value: unknown): value is z.ZodType =>
      typeof value === 'object' && value !== null && '_zod' in value
    if (structure.kind === 'map') {
      if (!isSchema(structure.value) || !['any', 'nonempty', 'nonblank'].includes(structure.keys))
        fail(path, 'malformed map descriptor')
    } else if (
      !isSchema(structure.steps) ||
      !isSchema(structure.table) ||
      (structure.afterReconcile !== undefined && !isSchema(structure.afterReconcile))
    )
      fail(path, 'malformed steps descriptor')
  }
  return result
}
interface Input {
  schema: z.ZodType
  metadata: ReferenceMetadata
  optional: boolean
  default: string
  constraints: string[]
}
function checks(schema: z.ZodType, path: string, meta: ReferenceMetadata): string[] {
  return (definition(schema).checks ?? []).map(({ _zod: { def } }) => {
    switch (def.check) {
      case 'number_format':
        if (def.format !== 'safeint') fail(path, `unsupported number format ${def.format}`)
        return 'safe integer'
      case 'greater_than':
        return `${def.inclusive ? '≥' : '>'} ${def.value}`
      case 'less_than':
        return `${def.inclusive ? '≤' : '<'} ${def.value}`
      case 'min_length':
        return `minimum length ${def.minimum}`
      case 'max_length':
        return `maximum length ${def.maximum}`
      case 'length_equals':
        return `length ${def.length}`
      case 'multiple_of':
        return `multiple of ${def.value}`
      case 'string_format':
        if (def.format !== 'regex' || !def.pattern)
          fail(path, `unsupported string format ${def.format}`)
        return `matches ${def.pattern}`
      case 'custom': {
        const message = def.error?.()
        if (message) return message
        if (meta.constraints) return meta.constraints
        return fail(path, 'custom refinement needs constraint metadata')
      }
      default:
        return fail(path, `unsupported check ${def.check}`)
    }
  })
}
/** Preserve outer defaults: optional(default(x)) still applies x in Zod 4. */
function input(schema: z.ZodType, path: string): Input {
  let current = schema
  let meta: ReferenceMetadata = {}
  let optional = false
  let fallback = 'omitted'
  let hasDefault = false
  const constraints: string[] = []
  for (;;) {
    const own = metadata(current, path)
    meta = { ...own, ...meta }
    constraints.push(...checks(current, path, meta))
    const def = definition(current)
    if (meta.structure) break
    if (['optional', 'default', 'prefault'].includes(def.type)) {
      optional = true
      if (!hasDefault && def.type !== 'optional') {
        fallback = JSON.stringify(def.defaultValue)
        if (def.type === 'prefault')
          fallback += ' (input supplied on omission; nested defaults apply)'
        hasDefault = true
      }
      if (!def.innerType) fail(path, 'wrapper has no inner schema')
      current = def.innerType
    } else if (def.type === 'pipe') {
      if (!def.in) fail(path, 'pipe has no input schema')
      // A transformation must explain input-to-output semantics, not hide them.
      if (!meta.constraints) fail(path, 'transform needs input constraint metadata')
      if (definition(def.in).type === 'unknown')
        fail(path, 'opaque transform needs a structural input descriptor')
      current = def.in
    } else break
  }
  // openMap and stepSection carry their descriptor on an outer prefault.
  if (meta.structure && definition(current).type === 'prefault' && !hasDefault) {
    optional = true
    fallback = `${JSON.stringify(definition(current).defaultValue)} (input supplied on omission)`
  }
  return {
    schema: current,
    metadata: meta,
    optional,
    default: meta.default ?? fallback,
    constraints,
  }
}
function typeOf(value: Input, path: string): string {
  if (value.metadata.structure) return 'table'
  const def = definition(value.schema)
  switch (def.type) {
    case 'object':
      if (!def.catchall || definition(def.catchall).type !== 'never')
        fail(path, 'unsupported non-strict object; use an explicit open-map descriptor')
      return 'strict table'
    case 'unknown':
      return 'plugin-owned TOML value'
    case 'string':
    case 'boolean':
    case 'number':
      return def.type
    case 'literal':
      return def.values!.map((v) => JSON.stringify(v)).join(' | ')
    case 'enum':
      return Object.values(def.entries!)
        .map((v) => JSON.stringify(v))
        .join(' | ')
    case 'array': {
      const elementInput = input(def.element!, `${path}[]`)
      const element = typeOf(elementInput, `${path}[]`)
      return `array of ${definition(elementInput.schema).type === 'union' ? `(${element})` : element}`
    }
    case 'union':
      return def.options!.map((v) => typeOf(input(v, path), path)).join(' | ')
    default:
      return fail(path, `unsupported schema node ${def.type}`)
  }
}
export interface ReferenceField {
  path: string
  type: string
  default: string
  required: string
  reload: string
  description: string
  constraints: string[]
  examples: string[]
  variant?: string
}
/** Optional ticket fields overlay the candidate in composeReloadedConfig. */
export const DOCUMENTATION_RELOAD_FALLBACK = {
  'tickets.url': 'hot',
  'tickets.doneState': 'hot',
} as const
export function reloadBehavior(path: string): string {
  const parts = path.replaceAll('[]', '').split('.')
  let classification: unknown = CONFIG_RELOAD_CLASSIFICATION
  for (const part of parts) {
    if (typeof classification === 'string') break
    classification = (classification as Record<string, unknown> | undefined)?.[part]
  }
  if (typeof classification === 'object' && classification !== null) {
    const values = Object.values(classification)
    classification = values.every((value) => value === values[0]) ? values[0] : 'mixed'
  }
  classification ??=
    DOCUMENTATION_RELOAD_FALLBACK[path as keyof typeof DOCUMENTATION_RELOAD_FALLBACK]
  if (!['hot', 'restart', 'mixed'].includes(String(classification)))
    fail(path, 'missing reload classification')
  const dispatcher =
    classification === 'hot'
      ? 'Hot: next dispatcher action captures the accepted value.'
      : classification === 'restart'
        ? 'Dispatcher restart required; startup adapters retain their configuration.'
        : 'Mixed: see individual fields for dispatcher reload behavior.'
  const owned = BUILD_OWNED_CONFIG_PATHS.some((prefix) => parts[0] === prefix)
  return `${dispatcher}${owned ? ' Build-owned pipeline: captured from the execution checkout each verify cycle; later base-branch edits do not replace it. Workspace provisioning applies at the next build launch.' : ''} A running invocation keeps its captured values.`
}
export function schemaFields(
  schema: z.ZodType,
  path: string,
  reload: (path: string) => string = reloadBehavior,
): ReferenceField[] {
  const fields: ReferenceField[] = []
  function visit(schema: z.ZodType, path: string, variant?: string): void {
    const value = input(schema, path)
    const def = definition(value.schema)
    const description = value.metadata.description ?? schema.description
    if (!description?.trim()) fail(path, 'missing nonempty description')
    const constraints = [...value.constraints]
    if (value.metadata.constraints) constraints.push(value.metadata.constraints)
    if (def.type === 'array') {
      const element = input(def.element!, `${path}[]`)
      constraints.push(...element.constraints.map((c) => `Each item: ${c}`))
      if (element.metadata.constraints)
        constraints.push(`Each item: ${element.metadata.constraints}`)
    }
    fields.push({
      path,
      type: typeOf(value, path),
      default: value.default,
      required:
        value.metadata.required ??
        (value.optional ? 'Optional' : 'Required') + (variant ? ` when ${variant}` : ''),
      reload: reload(path),
      description,
      constraints: [...new Set(constraints)],
      examples: value.metadata.examples ?? [],
      ...(variant ? { variant } : {}),
    })
    const structure = value.metadata.structure
    if (structure) {
      if (structure.kind === 'map') {
        if (!structure.value || !['any', 'nonempty', 'nonblank'].includes(structure.keys))
          fail(path, 'malformed map descriptor')
        fields[fields.length - 1]!.constraints.push(`Entry names: ${structure.keys}`)
        visit(structure.value, `${path}.<name>`, variant)
      } else if (structure.kind === 'steps') {
        if (!structure.steps || !structure.table) fail(path, 'malformed steps descriptor')
        visit(structure.steps, `${path}.steps`, variant)
        if (structure.afterReconcile)
          visit(structure.afterReconcile, `${path}.afterReconcile`, variant)
        visit(structure.table, `${path}.<step>`, variant)
      } else fail(path, 'unsupported structure descriptor')
    } else if (def.type === 'object') {
      for (const [key, child] of Object.entries(def.shape!)) visit(child, `${path}.${key}`, variant)
    } else if (def.type === 'array') {
      const element = input(def.element!, `${path}[]`)
      if (definition(element.schema).type === 'object') {
        for (const [key, child] of Object.entries(definition(element.schema).shape!))
          visit(child, `${path}[].${key}`, variant)
      } else if (element.metadata.structure) visit(def.element!, `${path}[]`, variant)
    } else if (def.type === 'union') {
      for (const option of def.options!) {
        const branch = input(option, path)
        const shape = definition(branch.schema).shape
        if (!shape) fail(path, 'union branch must be a strict table')
        const discriminator = shape.kind && definition(input(shape.kind, path).schema).values?.[0]
        if (typeof discriminator !== 'string')
          fail(path, 'union needs a literal kind discriminator')
        for (const [key, child] of Object.entries(shape))
          visit(child, `${path}.${key}`, `kind = ${JSON.stringify(discriminator)}`)
      }
    }
  }
  visit(schema, path)
  return fields
}
export function configurationReference(): Record<string, ReferenceField[]> {
  const regions: Record<string, ReferenceField[]> = { root: [] }
  for (const [key, schema] of Object.entries(configRootSchema.shape)) {
    const fields = schemaFields(schema, key)
    const type = fields[0]!.type
    if (!type.includes('table')) regions.root!.push(...fields)
    else regions[key] = fields
  }
  regions['pr-imageHost'] = regions.pr!.filter((field) => field.path.startsWith('pr.imageHost.'))
  regions.pr = regions.pr!.filter((field) => !field.path.startsWith('pr.imageHost.'))
  for (const [provider, declaration] of BUILTIN_WORKSPACE_PROVIDER_CONFIG) {
    if (declaration.configSchema)
      regions[`workspace-${provider}`] = schemaFields(declaration.configSchema, 'workspace.config')
    else if (declaration.configRefusalMessage)
      regions
        .workspace!.find((field) => field.path === 'workspace.config')!
        .constraints.push(
          `provider = ${JSON.stringify(provider)}: ${declaration.configRefusalMessage}`,
        )
    else fail('workspace.config', `builtin ${provider} has no declaration`)
  }
  return regions
}
export function renderFields(fields: readonly ReferenceField[]): string {
  return fields
    .map((field) =>
      [
        `#### \`${field.path}\`${field.variant ? ` (${field.variant})` : ''}`,
        '',
        `**TOML key:** \`${field.path}\``,
        '',
        `- **Type:** \`${field.type}\``,
        `- **Default:** \`${field.default}\``,
        `- **Required:** ${field.required}`,
        `- **Reload:** ${field.reload}`,
        '',
        `**Description:** ${field.description}`,
        '',
        `**Constraints:** ${field.constraints.length ? field.constraints.join('; ') : 'None beyond the input type.'}`,
        ...field.examples.flatMap((example) => ['', `**Example:** \`${example}\``]),
        '',
      ].join('\n'),
    )
    .join('\n')
}
