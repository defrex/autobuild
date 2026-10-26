import type { Accounts } from '../config/accounts'
import type { BuildStore } from './types'
import type { StreamPart } from './streams/types'

/** Values stay host-local. Previously observed values remain redacted after rotation. */
export class AccountRedactor {
  private readonly observed = new Set<string>()
  constructor(private readonly source: () => readonly (string | undefined)[]) {}
  private secrets(): string[] {
    for (const value of this.source()) if (value) this.observed.add(value)
    return [
      ...new Set(
        [...this.observed].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
      ),
    ].sort((a, b) => b.length - a.length)
  }
  text(value: string): string {
    for (const secret of this.secrets()) value = value.split(secret).join('[REDACTED]')
    return value
  }
  value<T>(value: T): T {
    if (typeof value === 'string') return this.text(value) as T
    if (value instanceof Uint8Array) {
      const copy = new Uint8Array(value)
      for (const secret of this.secrets()) {
        const needle = new TextEncoder().encode(secret)
        for (let i = 0; i <= copy.length - needle.length; i++) {
          if (needle.every((byte, j) => copy[i + j] === byte)) {
            copy.fill(42, i, i + needle.length)
            i += needle.length - 1
          }
        }
      }
      return copy as T
    }
    if (Array.isArray(value)) return value.map((item) => this.value(item)) as T
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [this.text(key), this.value(item)]),
      ) as T
    return value
  }
  /** Retain only a suffix that could begin a secret. Never persist a prefix
   * until the following delta disambiguates it, even across flush batches. */
  stream(parts: StreamPart[], tails: Map<string, string>): StreamPart[] {
    const result: StreamPart[] = []
    for (const part of parts) {
      const record = part as Record<string, unknown>
      if (
        (part.type === 'text-delta' || part.type === 'reasoning-delta') &&
        typeof record.delta === 'string'
      ) {
        const id = `${part.type}:${record.id}`
        let text = (tails.get(id) ?? '') + record.delta
        const secrets = this.secrets()
        text = this.text(text)
        let retained = 0
        for (const secret of secrets)
          for (let n = 1; n < secret.length && n <= text.length; n++)
            if (text.endsWith(secret.slice(0, n))) retained = Math.max(retained, n)
        tails.set(id, retained ? text.slice(-retained) : '')
        result.push({ ...part, delta: retained ? text.slice(0, -retained) : text } as StreamPart)
      } else {
        if (part.type === 'text-end' || part.type === 'reasoning-end') {
          const type = part.type === 'text-end' ? 'text-delta' : 'reasoning-delta'
          const id = `${type}:${record.id}`
          const tail = tails.get(id)
          if (tail) result.push({ type, id: record.id, delta: tail } as StreamPart)
          tails.delete(id)
        }
        result.push(this.value(part))
      }
    }
    return result
  }
}

export function accountRedactor(
  accounts: () => Accounts,
  env:
    | Readonly<Record<string, string | undefined>>
    | (() => Readonly<Record<string, string | undefined>>),
): AccountRedactor {
  return new AccountRedactor(() => {
    const current = typeof env === 'function' ? env() : env
    return Object.values(accounts()).map((account) => current[account.credentialEnv])
  })
}

const WRITES = new Set([
  'append',
  'appendIfCurrent',
  'appendWithArtifacts',
  'appendWithArtifactsIfCurrent',
  'putArtifact',
  'appendRepo',
  'appendRepoWithArtifacts',
  'putRepoArtifact',
  'appendSessionEvent',
  'appendSessionEventIfCurrent',
  'appendSessionWithArtifacts',
  'putSessionArtifact',
  'putTicketAsset',
  'putReducerSnapshot',
  'createSession',
])

/** Covers actual event/artifact write interfaces, including atomic callbacks.
 * The underlying adapter still validates schemas and computes content hashes. */
export function redactAccountStore<T extends BuildStore>(store: T, redactor: AccountRedactor): T {
  const streams = new Map<string, Map<string, string>>()
  return new Proxy(store, {
    get(target, property) {
      const member = Reflect.get(target, property, target)
      if (typeof member !== 'function') return member
      if (property === 'scopeBuild' || property === 'scopeSession')
        return (...args: unknown[]) => redactAccountStore(member.apply(target, args), redactor)
      if (
        !WRITES.has(String(property)) &&
        property !== 'appendStreamParts' &&
        property !== 'closeStream'
      )
        return member.bind(target)
      return async (...args: unknown[]) => {
        let committedTails: { id: string; tails: Map<string, string> } | undefined
        if (property === 'appendStreamParts') {
          const id = args[0] as string
          const tails = new Map(streams.get(id) ?? [])
          committedTails = { id, tails }
          args[1] = redactor.stream(args[1] as StreamPart[], tails)
        } else if (property === 'closeStream') streams.delete(args[0] as string)
        else if (WRITES.has(String(property)))
          args = args.map((arg) =>
            typeof arg === 'function'
              ? (...values: unknown[]) => redactor.value(arg(...values))
              : redactor.value(arg),
          )
        try {
          const result = await member.apply(target, args)
          if (committedTails) streams.set(committedTails.id, committedTails.tails)
          return result
        } catch (error) {
          if (error instanceof Error) {
            error.message = redactor.text(error.message)
            throw error
          }
          throw new Error(redactor.text(String(error)))
        }
      }
    },
  })
}
