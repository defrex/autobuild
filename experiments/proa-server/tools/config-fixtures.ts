/** Source-derived configuration grammar and differential cases. Runtime parsing
 * is native Rust; this tooling imports the TypeScript contract read-only. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'
import { configSchema, vercelSandboxConfigSchema } from '../../../packages/core/src/config/schema'
import { referenceMetadata } from '../../../packages/core/src/config/reference-metadata'
import { EVENT_TYPES } from '../../../packages/core/src/events/payloads'
import { REPOSITORY_EVENT_TYPES } from '../../../packages/core/src/events/repository'
import { CORE_PHASES } from '../../../packages/core/src/ontology'
import { INTERNAL_ROLES } from '../../../packages/core/src/config/roles'
import { decodeEffectiveConfig } from '../../../packages/core/src/operator/query'

type Def = Record<string, unknown>
const file = resolve(import.meta.dir, '../fixtures/config-schema.json')
const corpusFile = resolve(import.meta.dir, '../fixtures/config-corpus.json')
const def = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def
function message(value: unknown): string | undefined {
  if (typeof value === 'function') return value({}) as string | undefined
  return typeof value === 'string' ? value : undefined
}
function grammar(schema: z.ZodType, path: string[]): unknown {
  const d = def(schema)
  const metadata = referenceMetadata(schema)?.structure
  if (metadata?.kind === 'map')
    return {
      type: 'map',
      label: `[${(path[0] === 'vercel' ? ['workspace', 'config', ...path.slice(1)] : path).join('.')}]`,
      keys: metadata.keys,
      value: grammar(metadata.value, [...path, '*']),
    }
  if (metadata?.kind === 'steps')
    return {
      type: 'steps',
      label: `[${(path[0] === 'vercel' ? ['workspace', 'config', ...path.slice(1)] : path).join('.')}]`,
      steps: grammar(metadata.steps, [...path, 'steps']),
      table: grammar(metadata.table, [...path, '*']),
      afterReconcile: metadata.afterReconcile !== undefined,
    }
  const type = d.type as string
  const result: Record<string, unknown> = { type }
  const customMessage = message(d.error)
  if (customMessage !== undefined) result.error = customMessage
  if (['optional', 'default', 'prefault', 'nullable'].includes(type)) {
    result.inner = grammar(d.innerType as z.ZodType, path)
    if (type === 'default' || type === 'prefault') result.default = d.defaultValue
  } else if (type === 'pipe') {
    result.input = grammar(d.in as z.ZodType, path)
    const source = (def(d.out as z.ZodType).transform as (...args: never[]) => unknown).toString()
    if (path.join('.') === 'tickets') result.transform = 'tickets'
    else if (path.join('.') === 'store.url') result.transform = 'service-url'
    else throw Error(`Unported config transform at ${path.join('.')}: ${source}`)
    result.source = source
  } else if (type === 'object') {
    result.properties = Object.fromEntries(
      Object.entries(d.shape as Record<string, z.ZodType>).map(([key, value]) => [
        key,
        grammar(value, [...path, key]),
      ]),
    )
    result.strict = d.catchall !== undefined && def(d.catchall as z.ZodType).type === 'never'
  } else if (type === 'array') result.element = grammar(d.element as z.ZodType, path)
  else if (type === 'union') {
    result.options = (d.options as z.ZodType[]).map((s) => grammar(s, path))
    if (d.discriminator) result.discriminator = d.discriminator
  } else if (type === 'enum') result.values = Object.values(d.entries as object)
  else if (type === 'literal') result.values = d.values
  else if (!['string', 'number', 'boolean', 'unknown', 'never'].includes(type))
    throw Error(`Unported config schema type ${type}`)
  if (Array.isArray(d.checks))
    result.checks = d.checks.map((check: unknown) => {
      const c = def(check as z.ZodType)
      const item: Record<string, unknown> = { op: c.check }
      const error = message(c.error)
      if (error !== undefined) item.error = error
      for (const key of ['minimum', 'maximum', 'value', 'inclusive', 'format'])
        if (c[key] !== undefined) item[key] = c[key]
      if (c.pattern instanceof RegExp) {
        item.pattern = c.pattern.source
        item.patternDisplay = c.pattern.toString()
      }
      if (c.check === 'custom') {
        if (typeof c.fn === 'function') {
          const source = c.fn.toString()
          item.source = source
          if (/\.trim\(\)\.length\s*>\s*0/.test(source)) item.op = 'nonblank'
          else if (path.join('.') === 'tickets.readyAssignee') item.op = 'assignee'
          else if (path.join('.') === 'vercel.image') item.op = 'vercel-image'
          else throw Error(`Unported config predicate ${path.join('.')}: ${source}`)
        } else {
          item.op =
            path.length === 0
              ? 'root-cross'
              : path.join('.') === 'tickets'
                ? 'tickets-cross'
                : path.join('.') === 'vercel'
                  ? 'vercel-cross'
                  : path.at(-1) === 'paths'
                    ? 'path-glob'
                    : undefined
          if (!item.op) throw Error(`Unported config refinement ${path.join('.')}`)
        }
      }
      return item
    })
  return result
}
function schemaProbes() {
  const samples: unknown[] = [
    undefined,
    null,
    true,
    0,
    1,
    -1,
    1.5,
    1e16,
    '',
    ' ',
    '\uFEFF',
    'x',
    'owner/repo',
    'https://example.com/a///',
    'vercel/sandbox/universal',
    'builds.control:abort',
    [],
    [''],
    {},
    { length: 0 },
    { runtime: 'pi' },
    { steps: [] },
    { source: 'hosted', teamKey: 'ENG' },
  ]
  const seen = new Set<z.ZodType>()
  const probes: { path: string; grammar: unknown; cases: unknown[] }[] = []
  const walk = (schema: z.ZodType, path: string[]) => {
    if (seen.has(schema)) return
    seen.add(schema)
    probes.push({
      path: path.join('.'),
      grammar: grammar(schema, path),
      cases: samples.map((input) => {
        const parsed = schema.safeParse(input)
        return {
          ...(input === undefined ? {} : { input }),
          ...(parsed.success
            ? {
                success: true,
                defined: parsed.data !== undefined,
                ...(parsed.data === undefined ? {} : { output: parsed.data }),
              }
            : { success: false, issues: parsed.error.issues, error: parsed.error.message }),
        }
      }),
    })
    const metadata = referenceMetadata(schema)?.structure
    if (metadata?.kind === 'map') {
      walk(metadata.value, [...path, '*'])
      return
    }
    if (metadata?.kind === 'steps') {
      walk(metadata.steps, [...path, 'steps'])
      walk(metadata.table, [...path, '*'])
      return
    }
    const d = def(schema)
    if (d.shape)
      for (const [key, child] of Object.entries(d.shape as Record<string, z.ZodType>))
        walk(child, [...path, key])
    for (const key of ['innerType', 'in', 'element']) if (d[key]) walk(d[key] as z.ZodType, path)
    if (Array.isArray(d.options)) for (const child of d.options) walk(child as z.ZodType, path)
  }
  walk(configSchema, [])
  walk(vercelSandboxConfigSchema, ['vercel'])
  return probes
}
export function configurationContract() {
  const base = { tickets: { source: 'file', readyState: 'ready' } }
  const cases: unknown[] = [undefined, null, true, 1, '', [], {}, base, { ...base, unknown: true }]
  for (const key of Object.keys((configSchema as z.ZodObject).shape))
    for (const input of [null, true, 0, -1, 1.5, 1e16, '', ' ', [], {}])
      cases.push({ ...base, [key]: input })
  for (const input of [
    { source: 'hosted', teamKey: 'ENG' },
    { source: 'linear' },
    { source: 'file', readyState: 'ready', teamKey: 'ENG', claimedState: 'doing' },
    { source: 'plugin', readyState: 'ready', readyAssignee: 'me' },
    { source: 'hosted', teamKey: 'ENG', url: 'https://example.com///' },
    { source: 'hosted', teamKey: 'ENG', url: 'http://example.com' },
    { source: 'linear', readyState: 'ready', teamKey: 'ENG', url: 'https://example.com' },
    { source: 'file', readyState: '\uFEFF' },
    { source: 'file', readyState: 1 },
    { source: 'linear', teamKey: 'ENG', readyState: 'ready', readyAssignee: ' person@example.com' },
  ])
    cases.push({ ...base, tickets: input })
  for (const verify of [
    { steps: ['unit'], unit: { kind: 'check', command: 'test' } },
    ...[[['unit']], [['unit', 'types'], 'lint'], [[], 'unit'], [['unit'], 'unit']].map((steps) => ({
      steps,
      ...Object.fromEntries(steps.flat().map((name) => [name, { kind: 'check', command: 'test' }])),
    })),
    { steps: ['absent'] },
    { steps: [], unit: { kind: 'check', command: 'missing' } },
    { steps: ['..'], '..': { kind: 'agent', skill: 'verify' } },
    { steps: ['x'], x: { kind: 'check', skill: 'bad' } },
    { steps: ['x'], x: { kind: 'agent', skill: 'check', paths: [] } },
    ...[
      '',
      '/tmp',
      'C:/tmp',
      'a\\b',
      '!a',
      '[ab]',
      '@(x)',
      'a//b',
      'a/../b',
      'a**b',
      '**/src?.ts',
      'a\0b',
    ].map((path) => ({ steps: ['x'], x: { kind: 'agent', skill: 'check', paths: [path] } })),
  ])
    cases.push({ ...base, commands: { test: 'true' }, verify })
  for (const raw of [
    {
      commands: JSON.parse('{"__proto__":"true","constructor":"false"}'),
      roles: JSON.parse('{"__proto__":{"runtime":"pi"}}'),
    },
    { plugins: ['a', 'a'] },
    { landing: [{ mode: 'auto', into: ' ', label: ' ' }] },
    { store: { url: 'https://example.com/a///' } },
    { store: { url: ' HTTPS://example.com' } },
    { store: { url: 'http://localhost:8080///' } },
    { store: { url: 'broken' } },
    { pr: { imageHost: { provider: 'github-release', repository: 'bad', releaseId: 0 } } },
    { workspace: { provider: 'git-worktree', config: { unknown: true } } },
    {
      workspace: {
        provider: 'plugin',
        config: JSON.parse('{"__proto__":{"anything":[1,null,true]}}'),
      },
    },
    { workspace: { provider: 'vercel-sandbox', config: { timeoutSeconds: 60 } } },
    {
      workspace: {
        provider: 'vercel-sandbox',
        config: {
          timeoutSeconds: 1,
          image: 'other',
          vcpus: 33,
          environmentVariables: ['BAD-NAME', 'A', 'A'],
          failoverRegions: ['iad', 'iad'],
          region: 'iad',
          gitUsernameEnv: 'GH_TOKEN',
        },
      },
    },
    {
      workspace: {
        provider: 'vercel-sandbox',
        config: {
          timeoutSeconds: 60,
          runtimeProvisioning: { pi: { install: 'x', preflight: 'y' } },
        },
      },
      roles: { default: { runtime: 'pi' } },
    },
    {
      workspace: { provider: 'vercel-sandbox', config: { timeoutSeconds: 60 } },
      roles: {
        default: { runtime: 'pi' },
        implement: { runtime: 'codex', alternates: [{ runtime: 'claude' }] },
      },
    },
    {
      workspace: {
        provider: 'vercel-sandbox',
        config: {
          timeoutSeconds: 60,
          provisioning: [
            { name: 'x', command: ' ' },
            { name: 'x', command: 'echo' },
          ],
          gitUsernameEnv: 'X',
          gitPasswordEnv: 'Y',
          environmentVariables: ['X', 'Y'],
        },
      },
    },
    { orchestrator: { invocationBudgetSeconds: 1000 } },
    { orchestrator: { enabled: true } },
    {
      orchestrator: {
        enabled: true,
        model: 'x',
        sandbox: { environmentVariables: ['GH_TOKEN', 'AB_STORE'] },
      },
    },
    { orchestrator: { approvals: ['Bad'] } },
    { orchestrator: { wake: ['not.real'] } },
    { orchestrator: { wake: ['build.*', 'harvest.*'] } },
  ])
    cases.push({ ...base, ...raw })
  return {
    format: 1,
    probes: schemaProbes(),
    source: Object.fromEntries(
      [
        'config/schema.ts',
        'config/landing.ts',
        'config/roles.ts',
        'config/reference-metadata.ts',
        'connection.ts',
        'open-map.ts',
        'zod-issues.ts',
        'events/globs.ts',
        'ontology.ts',
        'ports/workspace/provider-capabilities.ts',
      ].map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(import.meta.dir, '../../../packages/core/src', path)))
          .digest('hex'),
      ]),
    ),
    grammar: grammar(configSchema, []),
    vercel: grammar(vercelSandboxConfigSchema, ['vercel']),
    eventTypes: [...EVENT_TYPES, ...REPOSITORY_EVENT_TYPES],
    coreRoles: [...CORE_PHASES, ...INTERNAL_ROLES],
    cases: cases.map((input, index) => {
      const parsed = configSchema.safeParse(input)
      return {
        id: `config-${index}`,
        ...(input === undefined ? {} : { input }),
        ...(parsed.success
          ? { output: parsed.data }
          : { issues: parsed.error.issues, error: parsed.error.message }),
      }
    }),
    byteCases: ['{', '\uFEFF{"tickets":{"source":"hosted","teamKey":"ENG"}}'].map((raw, index) => {
      try {
        return {
          id: `bytes-${index}`,
          base64: Buffer.from(raw).toString('base64'),
          output: decodeEffectiveConfig(Buffer.from(raw), 'test@0'),
        }
      } catch (error) {
        return {
          id: `bytes-${index}`,
          base64: Buffer.from(raw).toString('base64'),
          error: (error as Error).message,
        }
      }
    }),
  }
}
function splitContract() {
  const raw = configurationContract()
  // The contract is transported as JSON; null-prototype open maps remain own
  // entries after that transport rather than retaining JS prototype identity.
  const { cases, probes, byteCases, ...runtime } = JSON.parse(JSON.stringify(raw)) as typeof raw
  return { runtime, corpus: { source: runtime.source, cases, probes, byteCases } }
}
export async function checkConfigurationContract() {
  const { runtime, corpus } = splitContract()
  if (
    !isDeepStrictEqual(await Bun.file(file).json(), runtime) ||
    !isDeepStrictEqual(await Bun.file(corpusFile).json(), corpus)
  )
    throw Error('Config schema drifted; run tools/config-fixtures.ts --write')
}
if (import.meta.main) {
  if (process.argv.includes('--write')) {
    const { runtime, corpus } = splitContract()
    await Bun.write(
      file,
      `${JSON.stringify(runtime, null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`,
    )
    await Bun.write(
      corpusFile,
      `${JSON.stringify(corpus, null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`,
    )
  } else await checkConfigurationContract()
}
