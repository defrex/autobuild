import type { z } from 'zod'
import {
  newBuildBodySchema,
  ensureRepoBodySchema,
  leaseClaimBodySchema,
  leaseHolderBodySchema,
  newSessionBodySchema,
  eventWriteWireSchema,
  conditionalEventBodySchema,
  reducerSnapshotPutBodySchema,
  operatorPresenceBodySchema,
  putArtifactBodySchema,
  depositsBodySchema,
  finishRepoTickBodySchema,
  createStreamBodySchema,
  appendStreamBodySchema,
  closeStreamBodySchema,
  putTicketAssetBodySchema,
  removeTicketAssetBodySchema,
} from '../../../packages/core/src/store/remote/protocol'
import { repoTickCompletionSchema } from '../../../packages/core/src/store/repo-tick'
import { eventPayloadSchemas } from '../../../packages/core/src/events/payloads'
import { repositoryEventPayloadSchemas } from '../../../packages/core/src/events/repository'
import { sessionEventPayloadSchemas } from '../../../packages/core/src/events/sessions'

/** A small closed interpreter input, not an acceptance oracle or stored-event
 * schema. Unknown Zod constructs fail generation, so adding a producer check
 * cannot silently weaken a Rust write validator. Custom checks are named and
 * implemented in Rust; the source closure pins their actual TypeScript code.
 */
export function schemaNode(schema: z.ZodType, path: string): unknown {
  const def = schema._zod.def as unknown as Record<string, unknown>
  const type = def.type as string
  const out: Record<string, unknown> = { type }
  if (def.coerce) throw new Error(`Unsupported producer coercion: ${path}`)
  const message = (error: unknown) => {
    if (error === undefined) return undefined
    const result = typeof error === 'function' ? error({ input: undefined }) : error
    if (typeof result !== 'string')
      throw new Error(`Dynamic error override requires explicit port: ${path}`)
    return result
  }
  const customName = (raw: Record<string, unknown>) => {
    const fn = String(raw.fn ?? '')
    if (fn.includes('isPhase(value)')) return fn.includes('"setup"') ? 'escalation_target' : 'phase'
    if (fn.includes('trim().length > 0')) return 'nonblank'
    if (fn.includes('[native code]') && fn.includes('isAbsolute')) return 'absolute_path'
    if (fn.includes('value !== "."')) return 'filename_component'
    if (fn.includes('u0000-')) return 'filename_basename'
    if (fn.includes('url.startsWith("https://")')) return 'https_url'
    if (path === 'target.distance') return 'target_distance'
    if (fn.includes('request.reason !== "presence"')) return 'presence_demand'
    if (fn.includes('value.commandSeq !==')) return 'landing_intent'
    if (fn.includes('new Set(steps).size')) return 'unique_values'
    if (fn.includes('ids.every(')) return 'sorted_identities'
    if (fn.includes('value.selectedIndex !== value.failed.index')) return 'different_target'
    if (fn.includes('new Set(attempts.map')) return 'unique_attempts'
    if (path === 'turn.started.trigger.options.1') return 'wake_exclusive_source'
    if (path === 'tickets.migration-recorded') return 'ticket_migration'
    if (path === 'dispatcher.config-reloaded.restartRequired') return 'restart_paths'
    if (path === 'plan.completed.verifySteps.inner') return 'verify_steps'
    if (path === 'verify.reconcile-policy-captured.steps') return 'verify_policy_steps'
    if (path.endsWith('.providerAttempts.inner')) return 'ordered_attempts'
    if (path.endsWith('.substitution.inner')) return 'provider_substitution'
    throw new Error(`Unsupported custom producer check: ${path}/${fn}`)
  }
  const checks = ((def.checks ?? []) as { _zod: { def: Record<string, unknown> } }[]).map(
    (check) => check._zod.def,
  )
  if (def.check) checks.unshift(def)
  if (checks.length)
    out.checks = checks.map((raw) => {
      const common = {
        ...(message(raw.error) === undefined ? {} : { message: message(raw.error) }),
        ...(raw.abort === true ? { abort: true } : {}),
      }
      if (raw.check === 'custom') return { check: customName(raw), ...common }
      if (raw.check === 'overwrite') {
        if (String(raw.tx) !== '(input) => input.trim()')
          throw new Error(`Unknown producer overwrite: ${path}/${raw.tx}`)
        return { check: 'trim' }
      }
      if (raw.check === 'string_format') {
        if (!['regex', 'datetime', 'uuid', 'starts_with', 'url'].includes(raw.format as string))
          throw new Error(`Unknown producer string format: ${path}/${raw.format}`)
        const pattern = raw.pattern as RegExp | undefined
        if (pattern && /[^i]/.test(pattern.flags))
          throw new Error(`Unsupported producer regex flags: ${path}`)
        if (pattern?.source.includes('\\s') && pattern.source !== String.raw`^[^/\s]+\/[^/\s]+$`)
          throw new Error(`Unsupported producer whitespace pattern: ${path}`)
        return {
          check: 'string_format',
          format: raw.format,
          ...(pattern
            ? { source: pattern.source, flags: pattern.flags, pattern: pattern.toString() }
            : {}),
          ...(raw.prefix ? { prefix: raw.prefix } : {}),
          ...common,
        }
      }
      if (raw.check === 'number_format' && raw.format === 'safeint')
        return { check: raw.check, format: raw.format, ...common }
      if (['greater_than', 'less_than'].includes(raw.check as string))
        return { check: raw.check, value: raw.value, inclusive: raw.inclusive, ...common }
      if (raw.check === 'min_length') return { check: raw.check, minimum: raw.minimum, ...common }
      if (raw.check === 'max_length') return { check: raw.check, maximum: raw.maximum, ...common }
      throw new Error(`Unsupported producer check: ${path}/${raw.check}`)
    })
  if (def.error && type !== 'custom')
    throw new Error(`Unsupported producer error override: ${path}`)
  switch (type) {
    case 'object': {
      out.shape = Object.fromEntries(
        Object.entries(def.shape as Record<string, z.ZodType>).map(([key, child]) => [
          key,
          node(child, `${path}.${key}`),
        ]),
      )
      out.strict = (def.catchall as z.ZodType)?._zod.def.type === 'never'
      if (def.catchall && !out.strict) out.catchall = node(def.catchall as z.ZodType, `${path}.*`)
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
      if ((def.keyType as z.ZodType)._zod.def.type !== 'string')
        throw new Error(`Unsupported producer record key: ${path}`)
      out.key = node(def.keyType as z.ZodType, `${path}.key`)
      out.value = node(def.valueType as z.ZodType, `${path}.value`)
      break
    case 'union':
      if (def.discriminator) out.discriminator = def.discriminator
      out.options = (def.options as z.ZodType[]).map((child, index) =>
        node(child, `${path}.options.${index}`),
      )
      if (
        def.discriminator &&
        !(out.options as { type: string; shape?: Record<string, { type: string }> }[]).every(
          (option) =>
            option.type === 'object' &&
            ['literal', 'enum'].includes(option.shape?.[def.discriminator as string]?.type ?? ''),
        )
      )
        throw new Error(`Unsupported discriminated producer option: ${path}`)
      break
    case 'custom':
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
  snapshotPut: reducerSnapshotPutBodySchema,
  operatorPresence: operatorPresenceBodySchema,
  putArtifact: putArtifactBodySchema,
  deposits: depositsBodySchema,
  finishRepoTick: finishRepoTickBodySchema,
  tickCompletion: repoTickCompletionSchema,
  createStream: createStreamBodySchema,
  appendStream: appendStreamBodySchema,
  closeStream: closeStreamBodySchema,
  putTicketAsset: putTicketAssetBodySchema,
  removeTicketAsset: removeTicketAssetBodySchema,
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
        supported[scope]![name] = node(schema, name)
      } catch (error) {
        unsupported[scope]![name] = error instanceof Error ? error.message : String(error)
      }
    }
  }
  return { supported, unsupported }
}

/** Hand-authored relational/optional witnesses complement mechanical field
 * mutations. Oracles remain the core validators and actual TypeScript server;
 * none of these payloads is used by the Rust runtime. */
export function producerPayloadVariants(scope: string, type: string, payload: unknown) {
  if (scope === 'session') return []
  const out: { name: string; payload: unknown }[] = []
  const root = payload as Record<string, unknown>
  const add = (name: string, value: unknown) =>
    out.push({ name: `refinement/payload/${name}`, payload: value })
  const patch = (name: string, fields: Record<string, unknown>) =>
    add(name, { ...structuredClone(root), ...fields })
  if (type === 'target.distance') {
    patch('unknown', { head: null, count: null })
    patch('missing-head', { head: null, count: 1 })
    patch('zero', { count: 0 })
  }
  const replace = (path: (string | number)[], value: unknown) => {
    const result = structuredClone(root)
    let target: Record<string | number, unknown> = result
    for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>
    target[path.at(-1)!] = value
    return result
  }
  function strings(value: unknown, path: (string | number)[] = []) {
    if (typeof value === 'string') {
      add(`whitespace/${path.join('.')}`, replace(path, ` \ufeff${value}\t `))
      add(`newline/${path.join('.')}`, replace(path, `${value}\n`))
    } else if (Array.isArray(value))
      value.forEach((v, i) => {
        strings(v, [...path, i])
      })
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) strings(v, [...path, k])
  }
  strings(payload)
  const handle = {
    version: 1,
    runner: 'runner',
    nativeId: 'native',
    host: 'host',
    workspacePath: '/tmp/workspace',
    statePath: '/tmp/state',
  }
  const handlePayload = (value: unknown) => {
    if (type === 'session.started')
      return {
        ...root,
        continuation: {
          predecessor: 'previous',
          root: 'root',
          handle: value,
          cause: 'pause',
          activeMs: 0,
          budgetMs: 1,
        },
      }
    if (type === 'harvest.session.started')
      return {
        ...root,
        continuation: { predecessor: 'previous', root: 'root', handle: value, cause: 'cutover' },
      }
    return { ...root, handle: value }
  }
  if (
    [
      'session.started',
      'session.suspended',
      'session.resumed',
      'session.native-handle-recorded',
      'harvest.session.started',
      'harvest.session.resumed',
      'harvest.session.native-handle-recorded',
    ].includes(type)
  ) {
    add('native-handle', handlePayload(handle))
    for (const key of ['runner', 'nativeId', 'host', 'workspacePath', 'statePath']) {
      add(`handle-blank-${key}`, handlePayload({ ...handle, [key]: ' \ufeff\t' }))
      if (key.endsWith('Path'))
        add(`handle-relative-${key}`, handlePayload({ ...handle, [key]: 'relative/path' }))
    }
  }
  const failed = { index: 0, session: 'failed', runner: 'runner', error: 'failed' }
  if (['session.started', 'harvest.session.started'].includes(type)) {
    for (const selectedIndex of [0, 1, 2])
      patch(`substitution-${selectedIndex}`, { substitution: { failed, selectedIndex } })
  }
  if (['phase.failed', 'harvest.failed'].includes(type)) {
    for (const indices of [[0, 1], [1, 0], [0, 0], []])
      patch(`attempt-indices-${indices.join('-')}`, {
        providerAttempts: indices.map((index) => ({ ...failed, index })),
      })
  }
  if (type === 'plan.completed')
    for (const steps of [['lint'], ['lint', 'lint'], [' '], ['']])
      patch(`verify-steps-${JSON.stringify(steps)}`, { verifySteps: steps })
  if (type === 'integration.verification-failed')
    for (const steps of [[' lint ', 'types '], [' lint', 'lint '], [' ']])
      patch(`failed-steps-${JSON.stringify(steps)}`, { steps })
  if (type === 'verify.reconcile-policy-captured') {
    patch('policy-valid', {
      steps: [{ step: 'lint', enabled: true, source: 'verify.lint.afterReconcile' }],
    })
    patch('policy-invalid', {
      steps: [
        { step: 'lint', enabled: true, source: 'invalid' },
        { step: 'lint', enabled: false, source: 'invalid' },
      ],
    })
  }
  if (type === 'dispatcher.config-reloaded')
    patch('restart-duplicate', { restartRequired: ['store', 'store'] })
  if (type === 'tickets.migration-recorded') {
    patch('migration-source', { from: 'file', to: 'file', mapping: { a: 'b' } })
    patch('migration-duplicate', { from: 'file', to: 'hosted', mapping: { a: 'b', c: 'b' } })
    patch('migration-invalid-key', { mapping: { '': 'destination' } })
    patch('migration-proto-key', { mapping: JSON.parse('{"__proto__":"destination","a":"b"}') })
  }
  if (type === 'integration.landing-intended') {
    const value = { ...root }
    delete value.commandSeq
    delete value.decisionSeq
    add('missing-decision', value)
  }
  if (type === 'node.restack-requested') {
    patch('presence-missing', { reason: 'presence' })
    patch('presence-complete', {
      reason: 'presence',
      dependent: { source: 'file', id: 'ticket', title: 'Ticket' },
      identities: ['build:ticket'],
    })
  }
  if (type === 'change-presence.observed')
    for (const identities of [
      ['build:a', 'build:b'],
      ['build:b', 'build:a'],
      ['build:a', 'build:a'],
    ])
      patch(`sorted-${identities.join('-')}`, { identities })
  if (type === 'verify.completed')
    for (const reason of ['  because  ', ' \ufeff ', '']) {
      const value = { ...root, outcome: 'skipped', reason }
      delete (value as Record<string, unknown>).pass
      add(`skipped-${JSON.stringify(reason)}`, value)
    }
  if (type === 'finalize.step-completed')
    for (const headSha of ['  abc  ', ' \ufeff ', ''])
      patch(`head-${JSON.stringify(headSha)}`, { ok: true, headSha })
  if (type === 'pr-attachment.designated')
    for (const filename of [' ', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'a\u007fb', 'file.png'])
      patch(`filename-${JSON.stringify(filename)}`, { filename })
  if (type === 'pr-attachment.hosted')
    for (const url of [
      'https://example.test/file',
      'http://example.test/file',
      ' https://example.test/file ',
      'not a URL',
    ])
      patch(`url-${JSON.stringify(url)}`, { asset: { ...(root.asset as object), url } })
  if (type === 'build.created') {
    for (const repository of ['owner/repo', ' owner/repo', 'owner/repo\n', 'owner/\u00a0repo'])
      patch(`repository-${JSON.stringify(repository)}`, {
        pr: { imageHost: { provider: 'github-release', repository, releaseId: 1 } },
      })
    for (const kind of ['ticket-snapshot-abc', 'invalid', 'ticket-snapshot-abc\n'])
      patch(`asset-snapshot-${JSON.stringify(kind)}`, {
        assets: [
          {
            kind: 'design',
            name: 'ref',
            revision: 0,
            layout: 'file',
            size: 0,
            fileCount: 0,
            dirCount: 0,
            snapshot: { kind, revision: 0 },
          },
        ],
      })
  }
  return out
}

const node = schemaNode
