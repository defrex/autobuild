import { randomUUID } from 'node:crypto'
import type { Accounts } from '../config/accounts'
import { refreshChatGPT } from './chatgpt-oauth'
import type { LocalCredentials } from './local-credentials'
import type { ChatGPTState } from './chatgpt-state'

/** One claimed dispatcher/validator owns renewal. Durable refreshing state is
 * written before HTTP, and uncertain completion is terminal for that generation. */
export class LocalAccountOwner {
  readonly id = randomUUID()
  readonly injected = new Map<string, string>()
  constructor(
    readonly credentials: LocalCredentials,
    private readonly refresh = refreshChatGPT,
  ) {}
  claim(name: string): void {
    this.credentials.locked(name, () => {
      const r = this.credentials.load(name)
      if (!r || (r.owner && r.owner !== this.id && !ownerProcessEnded(r.ownerPid)))
        throw new Error('ChatGPT account already owned or missing')
      if (r.status === 'refreshing') r.status = 'failed'
      this.credentials.save(name, { ...r, owner: this.id, ownerPid: process.pid })
    })
  }
  release(name: string): void {
    this.credentials.locked(name, () => {
      const r = this.credentials.load(name)
      if (r?.owner === this.id) {
        delete r.owner
        delete r.ownerPid
        this.credentials.save(name, r)
      }
    })
  }
  async tick(accounts: Accounts, now = Date.now()): Promise<Record<string, string>> {
    const env: Record<string, string> = {}
    for (const [name, descriptor] of Object.entries(accounts)) {
      if (descriptor.kind !== 'chatgpt-subscription') continue
      let r = this.credentials.load(name)
      if (!r || r.owner !== this.id || JSON.stringify(r.descriptor) !== JSON.stringify(descriptor))
        throw new Error('ChatGPT account ownership or descriptor changed; sign in again')
      if (r.status !== 'ready') throw new Error('ChatGPT account failed; sign in again')
      if (now >= Math.max(r.state.earliestRefreshAt ?? 0, r.state.expiresAt - 60000)) {
        const claim = this.credentials.locked(name, () => {
          const current = this.credentials.load(name)
          if (
            !current ||
            current.owner !== this.id ||
            current.generation !== r!.generation ||
            current.status !== 'ready'
          )
            throw new Error('ChatGPT account changed')
          this.credentials.save(name, { ...current, status: 'refreshing' })
          return current
        })
        try {
          const state: ChatGPTState = await this.refresh(claim.state, AbortSignal.timeout(15000))
          this.credentials.locked(name, () => {
            const current = this.credentials.load(name)
            if (
              current?.generation === claim.generation &&
              current.owner === this.id &&
              current.status === 'refreshing'
            )
              this.credentials.save(name, { ...current, state, status: 'ready' })
          })
        } catch {
          this.credentials.locked(name, () => {
            const current = this.credentials.load(name)
            if (current?.generation === claim.generation && current.status === 'refreshing')
              this.credentials.save(name, { ...current, status: 'failed' })
          })
          throw new Error('ChatGPT refresh failed; sign in again')
        }
        r = this.credentials.load(name)!
      }
      if (r.status !== 'ready' || r.state.expiresAt <= now)
        throw new Error('ChatGPT account expired; sign in again')
      env[descriptor.credentialEnv] = r.state.accessToken
    }
    return env
  }
}

/** Unknown ownership and permission errors remain live; only OS proof of exit
 * permits reclaiming a record. An abandoned rotating attempt still fails closed. */
function ownerProcessEnded(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || pid! <= 0) return false
  try {
    process.kill(pid!, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Dispatcher renewal also recovers ready credentials after sleep or downtime.
 * Access expiry is not refresh failure; only the owner may consume refresh state. */
export async function renewLocalAccounts(
  owner: LocalAccountOwner,
  accounts: Accounts,
  env: Record<string, string | undefined>,
  claimed: Set<string>,
  now = Date.now(),
): Promise<void> {
  for (const [name, descriptor] of Object.entries(accounts)) {
    if (descriptor.kind !== 'chatgpt-subscription') continue
    try {
      const record = owner.credentials.load(name)
      if (!record) {
        if (owner.injected.get(descriptor.credentialEnv) === env[descriptor.credentialEnv])
          delete env[descriptor.credentialEnv]
        owner.injected.delete(descriptor.credentialEnv)
        continue
      }
      if (
        record.status === 'failed' ||
        JSON.stringify(record.descriptor) !== JSON.stringify(descriptor)
      )
        throw new Error('ChatGPT account failed or descriptor changed; sign in again')
      owner.claim(name)
      claimed.add(name)
      // Only expose a still-valid access value during the rotating HTTP call.
      if (record.state.expiresAt > now) env[descriptor.credentialEnv] = record.state.accessToken
      else delete env[descriptor.credentialEnv]
      Object.assign(env, await owner.tick({ [name]: descriptor }, now))
      owner.injected.set(descriptor.credentialEnv, env[descriptor.credentialEnv]!)
    } catch {
      delete env[descriptor.credentialEnv]
    }
  }
}

/** Inspect transferability without claiming ownership or consuming refresh state. */
export function inspectLocalAccountEnvironment(
  credentials: LocalCredentials,
  accounts: Accounts,
  env: Readonly<Record<string, string | undefined>>,
  predecessorPid?: number,
): Record<string, string | undefined> {
  const available = { ...env }
  for (const [name, descriptor] of Object.entries(accounts)) {
    if (descriptor.kind !== 'chatgpt-subscription') continue
    try {
      const record = credentials.load(name)
      if (!record) continue
      const ownerAvailable =
        !record.owner ||
        ownerProcessEnded(record.ownerPid) ||
        (predecessorPid !== undefined && record.ownerPid === predecessorPid)
      if (
        record.status === 'ready' &&
        (record.state.expiresAt > Date.now() ||
          Date.now() >= (record.state.earliestRefreshAt ?? 0)) &&
        ownerAvailable &&
        JSON.stringify(record.descriptor) === JSON.stringify(descriptor)
      )
        available[descriptor.credentialEnv] = 'local-refreshing-source'
      else delete available[descriptor.credentialEnv]
    } catch {
      delete available[descriptor.credentialEnv]
    }
  }
  return available
}
