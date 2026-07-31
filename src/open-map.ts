/**
 * The open-map preservation contract: author-chosen keys → strictly validated
 * values, with EVERY declared key surviving validation verbatim.
 *
 * `z.record` and `z.looseObject` build their result by assignment, so a
 * perfectly valid entry named `__proto__` invokes the legacy
 * `Object.prototype.__proto__` setter instead of creating an own key. Parsing
 * SUCCEEDS and the entry vanishes — never resolved, never selectable, and
 * invisible to whatever diagnostic exists to catch dead configuration. A silent
 * drop is the one outcome an otherwise strict validator must never produce.
 *
 * So these keep the key intact end to end: own descriptors in, `defineProperty`
 * out, null prototype on the result. Consumers can then read an author-chosen
 * key off these maps without `Object.hasOwn` ceremony, and a name nobody
 * declared answers `undefined` rather than an inherited object member.
 *
 * Two surfaces consume this. `autobuild.toml`'s open maps ([commands],
 * [roles], [workspace.config], and the named [verify.<step>] / [finalize.<step>]
 * table sets) are one; the plugin manifest's adapter maps (`ticketSources`,
 * `agentRuntimes`, `workspaceProviders`, `forges`) are the other, whose keys are
 * likewise author-chosen — there, by the plugin author rather than the operator.
 */
import { z } from 'zod'

type Ctx = { addIssue: (issue: { code: 'custom'; path?: PropertyKey[]; message: string }) => void }

/** How an entry name is validated. Autobuild-owned maps must be able to address
 * every entry, so a nameless one is dead configuration; a map whose names belong
 * to a plugin is not Autobuild's to narrow. */
export type OpenMapKeyPolicy = 'nonempty' | 'nonblank' | 'any'

export interface OpenMapOptions {
  keys?: OpenMapKeyPolicy
  /** What the container is called when the input is not one. */
  shape?: string
}

const DEFAULT_SHAPE = 'a table of named entries'

function keyIsValid(key: string, policy: OpenMapKeyPolicy): boolean {
  switch (policy) {
    case 'nonempty':
      return key.length > 0
    case 'nonblank':
      return key.trim().length > 0
    case 'any':
      return true
  }
}

/**
 * The two container shapes an open map accepts: a parsed TOML table, which the
 * TOML parser hands over with a null prototype, and a plain JavaScript object
 * literal. Nothing else is a map of named entries.
 *
 * The exclusions are load-bearing rather than pedantic. A `Map`, a `Set`, a
 * `Date`, an array, or a class instance has no own string-keyed entries to
 * collect, so accepting one would produce an EMPTY map from an input that
 * plainly meant to declare something — the same silent drop this module exists
 * to prevent, just arrived at from the other direction. `null` is rejected for
 * the same reason: absence is spelled by omission, which `openMap`'s
 * `.prefault({})` turns into `{}` before this ever runs.
 */
function isRecord(input: unknown): input is object {
  if (typeof input !== 'object' || input === null) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === null || prototype === Object.prototype
}

/** The own entries of a parsed container, read BY DESCRIPTOR. `input[key]` is
 * wrong here: on any object that has a prototype, reading `"__proto__"` answers
 * that prototype rather than the declared entry.
 *
 * `label` is rendered verbatim into the diagnostic — `'[roles]'` for a TOML
 * table, `'forges'` for a manifest map. */
export function ownEntries(
  input: unknown,
  label: string,
  ctx: Ctx,
  shape?: string,
): [string, unknown][] {
  if (!isRecord(input)) {
    ctx.addIssue({ code: 'custom', message: `${label} must be ${shape ?? DEFAULT_SHAPE}` })
    return []
  }
  return Object.getOwnPropertyNames(input).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    // TOML only ever produces data properties, but a manifest is real
    // JavaScript: `forges: { get acme() { … } }` is a valid declaration, and
    // `descriptor.value` is `undefined` for it. Invoking the getter still never
    // consults the prototype chain.
    const value =
      descriptor === undefined
        ? undefined
        : 'value' in descriptor
          ? descriptor.value
          : descriptor.get?.call(input)
    return [key, value]
  })
}

/** Record a named entry so the key survives verbatim. Plain assignment is what
 * loses `__proto__`; `defineProperty` on a null-prototype target cannot. */
export function defineEntry<T>(entries: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(entries, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** Validate one open-map value, forwarding every issue under its own key. */
export function parseEntry<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  key: string,
  ctx: Ctx,
): T | undefined {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', path: [key, ...issue.path], message: issue.message })
  }
  return undefined
}

/**
 * An open map: author-chosen keys → strictly validated values, keys preserved.
 *
 * Preservation is the shared contract; the key vocabulary is not. An
 * Autobuild-owned map names entries Autobuild itself must be able to address —
 * a role to dispatch, a command to run — so a nameless entry there is dead
 * configuration and an error. A plugin-owned pass-through map is not
 * Autobuild's to narrow, and a map of adapter names is narrower still: a name
 * made only of whitespace is unaddressable from configuration.
 */
export function openMap<T>(label: string, valueSchema: z.ZodType<T>, opts: OpenMapOptions = {}) {
  const keys = opts.keys ?? 'nonempty'
  return z
    .unknown()
    .transform((input, ctx): Record<string, T> => {
      const entries: Record<string, T> = Object.create(null)
      for (const [key, raw] of ownEntries(input, label, ctx, opts.shape)) {
        if (!keyIsValid(key, keys)) {
          ctx.addIssue({ code: 'custom', message: `${label} entry names must be ${keys}` })
          continue
        }
        const value = parseEntry(valueSchema, raw, key, ctx)
        if (value !== undefined) defineEntry(entries, key, value)
      }
      return entries
    })
    .prefault({})
}
