import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { openMap } from '../open-map'
import { documentFields, documentSchema } from './reference-metadata'
import {
  configurationReference,
  DOCUMENTATION_RELOAD_FALLBACK,
  reloadBehavior,
  renderFields,
  schemaFields,
} from './reference'
import { parseConfig } from './load'
import { composeReloadedConfig, BUILD_OWNED_CONFIG_PATHS } from './live'
import { BUILTIN_WORKSPACE_PROVIDER_CONFIG, configRootSchema } from './schema'

const doc = <T extends z.ZodType>(schema: T) =>
  documentSchema(schema, { description: 'Fixture description.' })
const fields = (schema: z.ZodType) => schemaFields(schema, 'fixture', () => 'fixture reload')

describe('configuration reference input adapter', () => {
  test('obsolete field descriptions name the field and regeneration command', () => {
    expect(() =>
      documentFields(z.strictObject({}), { removedField: 'Obsolete description.' }),
    ).toThrow(
      'removedField. Remove its obsolete description, then regenerate with bun run docs:configuration',
    )
  })

  test('derives nested keys, wrapper defaults, types and native constraints', () => {
    const model = fields(
      doc(
        z.strictObject({
          count: doc(z.number().int().min(2).max(8).default(4)),
          name: doc(
            z
              .string()
              .min(2)
              .max(5)
              .regex(/^[a-z]+$/)
              .optional(),
          ),
          mode: doc(z.enum(['auto', 'consent'])),
          enabled: doc(z.literal(true)),
          nested: doc(z.strictObject({ text: doc(z.string()) }).prefault({ text: 'hello' })),
          items: doc(z.array(z.strictObject({ value: doc(z.string()) })).min(1)),
        }),
      ),
    )
    expect(model.map((field) => field.path)).toEqual([
      'fixture',
      'fixture.count',
      'fixture.name',
      'fixture.mode',
      'fixture.enabled',
      'fixture.nested',
      'fixture.nested.text',
      'fixture.items',
      'fixture.items[].value',
    ])
    expect(model[1]).toMatchObject({
      default: '4',
      required: 'Optional',
      type: 'number',
      constraints: ['safe integer', '≥ 2', '≤ 8'],
    })
    expect(model[2]).toMatchObject({
      default: 'omitted',
      required: 'Optional',
      constraints: ['minimum length 2', 'maximum length 5', 'matches /^[a-z]+$/'],
    })
    expect(model[3]!.type).toBe('"auto" | "consent"')
    expect(model[4]!.type).toBe('true')
    expect(model[5]!.default).toContain('{"text":"hello"}')
    expect(model[7]!.constraints).toContain('minimum length 1')
  })

  test('preserves outer default/prefault order and pre-transform defaults', () => {
    expect(fields(doc(z.string().default('inner').optional()))[0]!.default).toBe('"inner"')
    expect(fields(doc(z.string().optional().default('outer')))[0]!.default).toBe('"outer"')
    expect(
      fields(doc(openMap('fixture', doc(z.string())).default({ command: 'echo hi' })))[0]!.default,
    ).toBe('{"command":"echo hi"}')
    expect(fields(doc(z.string().default('inner').prefault('outer')))[0]!.default).toContain(
      '"outer"',
    )
    const schema = documentSchema(
      z
        .number()
        .int()
        .default(9)
        .transform((value) => Math.min(value, 5)),
      {
        description: 'Clamped fixture.',
        constraints: 'Clamp after parsing.',
      },
    )
    expect(fields(schema)[0]).toMatchObject({ default: '9', type: 'number' })
    expect(schema.parse(undefined)).toBe(5)
  })

  test('follows open map construction and strict discriminated union variants', () => {
    const schema = doc(
      openMap(
        'fixture',
        doc(
          z.discriminatedUnion('kind', [
            z.strictObject({ kind: doc(z.literal('check')), command: doc(z.string().min(1)) }),
            z.strictObject({ kind: doc(z.literal('agent')), skill: doc(z.string().min(1)) }),
          ]),
        ),
        { keys: 'nonblank' },
      ),
    )
    const model = fields(schema)
    expect(model[0]!.constraints).toContain('Entry names: nonblank')
    expect(model.find((field) => field.path.endsWith('.command'))!.required).toBe(
      'Required when kind = "check"',
    )
    expect(model.find((field) => field.path.endsWith('.skill'))!.required).toBe(
      'Required when kind = "agent"',
    )
    expect(model[1]!.description).toBe('Fixture description.')
  })

  test('rejects missing nested/map-entry descriptions and opaque schema/checks', () => {
    expect(() => fields(doc(z.strictObject({ missing: z.string() })))).toThrow('fixture.missing')
    expect(() => fields(doc(openMap('fixture', z.string())))).toThrow('fixture.<name>')
    expect(() => fields(doc(z.date()))).toThrow('unsupported schema node date')
    expect(() =>
      fields(
        documentSchema(z.unknown(), {
          description: 'Map',
          structure: { kind: 'map', value: {}, keys: 'any' },
        } as never),
      ),
    ).toThrow('fixture: malformed map descriptor')
    expect(() => fields(doc(z.looseObject({})))).toThrow('unsupported non-strict object')
    expect(() => fields(doc(z.string().transform((value) => value.length)))).toThrow(
      'transform needs input constraint metadata',
    )
    expect(() =>
      fields(
        documentSchema(
          z.unknown().transform(() => ({})),
          { description: 'Opaque', constraints: 'Must be a table' },
        ),
      ),
    ).toThrow('opaque transform')
    expect(() => fields(doc(z.string().superRefine(() => {})))).toThrow(
      'custom refinement needs constraint metadata',
    )
    expect(() => fields(doc(z.string().email()))).toThrow('unsupported string format email')
    expect(() => fields(documentSchema(z.string(), { description: ' ' }))).toThrow('fixture')
    expect(() =>
      fields(documentSchema(z.string(), { description: 'OK', examples: [42] } as never)),
    ).toThrow('malformed examples')
    expect(() =>
      fields(documentSchema(z.string(), { description: 'OK', surprise: true } as never)),
    ).toThrow('unknown metadata')
    expect(() =>
      fields(
        documentSchema(z.unknown(), { description: 'OK', structure: { kind: 'future' } } as never),
      ),
    ).toThrow('unsupported structure')
  })

  test('schema changes alter generated bytes without a second field inventory', () => {
    const original = () => doc(z.strictObject({ name: doc(z.string().min(1).default('old')) }))
    const before = renderFields(fields(original()))
    const changes = [
      original().extend({ added: doc(z.boolean()) }),
      original().omit({ name: true }),
      doc(z.strictObject({ name: doc(z.string().min(1).default('new')) })),
      doc(z.strictObject({ name: doc(z.string().min(2).default('old')) })),
    ]
    for (const changed of changes) expect(renderFields(fields(doc(changed)))).not.toBe(before)
    expect(() => fields(doc(original().extend({ added: z.string() })))).toThrow('fixture.added')
  })
})

describe('real configuration reference', () => {
  test('covers root, builtin provider and deeply nested input fields without normalized output', () => {
    const regions = configurationReference()
    const all = Object.values(regions).flat()
    for (const key of Object.keys(configRootSchema.shape))
      expect(all.some((field) => field.path === key)).toBe(true)
    for (const [provider, declaration] of BUILTIN_WORKSPACE_PROVIDER_CONFIG) {
      if (declaration.configSchema)
        expect(regions[`workspace-${provider}`]).toEqual(
          schemaFields(declaration.configSchema, 'workspace.config'),
        )
    }
    const paths = all.map((field) => field.path)
    for (const path of [
      'roles.<name>.alternates[].runtime',
      'workspace.config.provisioning[].name',
      'workspace.config.runtimeProvisioning.<name>.install',
      'pr.imageHost.releaseId',
      'orchestrator.sandbox.idleMinutes',
      'verify.afterReconcile',
    ])
      expect(paths).toContain(path)
    expect(paths.some((path) => path.includes('stepConfigs'))).toBe(false)
    expect(regions.finalize!.some((field) => /afterReconcile|always|paths/.test(field.path))).toBe(
      false,
    )
    expect(regions.verify!.find((field) => field.path === 'verify.afterReconcile')!.default).toBe(
      'true',
    )
    for (const field of all) {
      expect(field.description.trim().length).toBeGreaterThan(0)
      for (const label of [
        'TOML key',
        'Type',
        'Default',
        'Required',
        'Reload',
        'Description',
        'Constraints',
      ])
        expect(renderFields([field])).toContain(`**${label}:**`)
    }
  })

  test('defaults and conditional ticket semantics agree with the parser', () => {
    const base = '[tickets]\nsource="file"\nreadyState="ready"'
    const config = parseConfig(base)
    expect(config.verify.afterReconcile).toBe(true)
    expect(config.verify.steps).toEqual([])
    expect(config.finalize.steps).toEqual([])
    expect(parseConfig(`${base}\n[verify]\nafterReconcile=false`).verify.afterReconcile).toBe(false)
    expect(parseConfig('[tickets]\nsource="hosted"\nteamKey="TEAM"').tickets.readyState).toBe(
      'ready',
    )
    expect(() => parseConfig('[tickets]\nsource="file"')).toThrow('readyState')
    expect(() => parseConfig(`${base}\nteamKey="TEAM"`)).toThrow('teamKey')
    expect(() => parseConfig('[tickets]\nsource="linear"\nreadyState="Ready"')).toThrow('teamKey')
    expect(parseConfig(`${base}\n[orchestrator]\nenabled=true`).orchestrator.enabled).toBe(true)
    expect(
      configurationReference().orchestrator!.some(
        (field) => field.path === 'orchestrator.invocationBudgetSeconds',
      ),
    ).toBe(false)
  })

  test('reload labels follow classifications and tested composition fallbacks', () => {
    expect(() => reloadBehavior('future')).toThrow('missing reload classification')
    expect(() => reloadBehavior('tickets.future')).toThrow('missing reload classification')
    const startup = parseConfig(
      '[tickets]\nsource="hosted"\nteamKey="TEAM"\nurl="https://old.example"\ndoneState="old"',
    )
    const candidate = parseConfig(
      '[tickets]\nsource="hosted"\nteamKey="TEAM"\nurl="https://new.example"\ndoneState="new"',
    )
    const composed = composeReloadedConfig(startup, candidate)
    for (const path of Object.keys(DOCUMENTATION_RELOAD_FALLBACK)) {
      const key = path.split('.')[1] as 'url' | 'doneState'
      expect(composed.tickets[key]).toBe(candidate.tickets[key])
      expect(reloadBehavior(path)).toContain('Hot: next dispatcher action')
    }
    for (const path of BUILD_OWNED_CONFIG_PATHS)
      expect(reloadBehavior(path)).toContain('Build-owned pipeline')
    expect(reloadBehavior('workspace.config.runtimeProvisioning.<name>.install')).toContain(
      'Dispatcher restart required',
    )
    expect(reloadBehavior('roles.<name>.runtime')).toContain('Hot:')
  })
})

test('verification reference groups its input union and documents semantic defaults and stage constraints', () => {
  const model = Object.values(configurationReference()).flat()
  const steps = model.find((field) => field.path === 'verify.steps')!
  expect(steps.type).toBe('array of (string | array of string)')
  expect(steps.constraints.join(' ')).toContain('at least one nonempty name')
  const failFast = model.filter((field) => field.path.endsWith('.failFast'))
  expect(failFast.length).toBeGreaterThan(0)
  for (const field of failFast) expect(field.default).toBe('false (omission is preserved)')
})
