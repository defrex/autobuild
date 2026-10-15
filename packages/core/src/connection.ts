import { normalizeGitRemoteUrl } from './kernel/origin'
/** Public device-approval protocol. Secrets travel only in capability POST bodies. */
export type ConnectionStatus = 'pending' | 'approved' | 'denied' | 'expired'
export interface ConnectionProposal {
  repo: string
  credentialId: string
  digest: string
}
export interface ConnectionOutcome {
  repo: string
  credentialId: string
  status: ConnectionStatus
}
export interface ConnectionStarted extends ConnectionOutcome {
  id: string
  capability: string
  code: string
  verificationURL: string
  interval: number
  expiresAt: string
}
export function normalizeServiceURL(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('store.url must be an absolute HTTPS service URL')
  }
  if (
    !raw.trim() ||
    raw !== raw.trim() ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  ) {
    throw new Error(
      'store.url must be HTTPS (HTTP is allowed on loopback), without credentials, query or fragment',
    )
  }
  return url.href.replace(/\/+$/, '')
}

export function normalizeConnectionRepository(raw: string): string {
  const value = raw.trim()
  // SSH's conventional git user is transport syntax; URL passwords and HTTPS
  // userinfo are never part of an identity (normalization would discard them).
  if (/[\s\\?#]/.test(value) || !value || (/^[^/]*:[^/]*@/.test(value) && !value.includes('://')))
    throw new Error('invalid repository identity')
  if (value.includes('://')) {
    let input: URL
    try {
      input = new URL(value)
    } catch {
      throw new Error('invalid repository identity')
    }
    if (input.password || (input.username && !['ssh:', 'git+ssh:'].includes(input.protocol))) {
      throw new Error('repository identity must not contain credentials')
    }
    if (input.search || input.hash) throw new Error('invalid repository identity')
  }
  const normalized = normalizeGitRemoteUrl(value)
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error('invalid repository identity')
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === '/' ||
    /%|\\/.test(url.pathname)
  ) {
    throw new Error('repository identity must be a normalized HTTPS repository origin')
  }
  return normalized
}
