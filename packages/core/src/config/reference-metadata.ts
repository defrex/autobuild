import type { z } from 'zod'

/** Documentation describes input semantics; it never participates in validation. */
export interface ReferenceMetadata {
  description?: string
  constraints?: string
  required?: string
  examples?: string[]
  structure?:
    | { kind: 'map'; value: z.ZodType; keys: string }
    | { kind: 'steps'; steps: z.ZodType; table: z.ZodType; afterReconcile?: z.ZodType }
}
const registry = new WeakMap<z.ZodType, ReferenceMetadata>()
export function referenceMetadata(schema: z.ZodType): ReferenceMetadata | undefined {
  return registry.get(schema)
}
export function documentSchema<T extends z.ZodType>(schema: T, metadata: ReferenceMetadata): T {
  registry.set(schema, { ...registry.get(schema), ...metadata })
  return schema
}
/** A description map is deliberately not an inventory: traversal reads the schema. */
export function documentFields(schema: z.ZodObject, descriptions: Record<string, string>): void {
  for (const [key, description] of Object.entries(descriptions)) {
    const field = schema.shape[key]
    if (!field) throw new Error(`Documentation names an unknown field: ${key}`)
    documentSchema(field, { description })
  }
}
