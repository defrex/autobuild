import { randomUUID } from 'node:crypto'
import type { Accounts } from '../config/accounts'
import { refreshChatGPT } from './chatgpt-oauth'
import type { LocalCredentials } from './local-credentials'
import type { ChatGPTState } from './chatgpt-state'

/** One claimed dispatcher/validator owns renewal. Durable refreshing state is
 * written before HTTP, and uncertain completion is terminal for that generation. */
export class LocalAccountOwner {
  readonly id = randomUUID()
  constructor(
    readonly credentials: LocalCredentials,
    private readonly refresh = refreshChatGPT,
  ) {}
  claim(name: string, acknowledgedTakeover = false): void {
    this.credentials.locked(name, () => {
      const r = this.credentials.load(name)
      if (!r || (r.owner && r.owner !== this.id && !acknowledgedTakeover))
        throw new Error('ChatGPT account already owned or missing')
      if (r.status === 'refreshing') r.status = 'failed'
      this.credentials.save(name, { ...r, owner: this.id })
    })
  }
  release(name: string): void {
    this.credentials.locked(name, () => {
      const r = this.credentials.load(name)
      if (r?.owner === this.id) {
        delete r.owner
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
