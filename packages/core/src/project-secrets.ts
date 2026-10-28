/** Public, write-only project-secret protocol. Plaintext resolution is server-internal. */
export const PROJECT_SECRETS_VERSION = 1
export class ProjectSecretError extends Error {
  constructor(
    readonly code: 'invalid-secret' | 'key-unavailable' | 'secret-unavailable' | 'stale-secrets',
  ) {
    super(`Project secrets: ${code}`)
  }
}
export interface ProjectSecretMetadata {
  name: string
  kind: string
  owner: string
  setAt: string
  fingerprint: string
  status: 'ready' | 'refreshing' | 'failed'
  failureCode: string | null
  lastSuppliedAt: string | null
  warnings?: Array<'refresh-window-too-short'>
}
export interface SecretSetRequest {
  version: 1
  repo: string
  name: string
  value: string
}
export interface SecretRemoveRequest {
  version: 1
  repo: string
  name: string
}
export interface SecretListResponse {
  version: 1
  secrets: ProjectSecretMetadata[]
}
export { SECRET_NAME_EXPLANATION } from './secret-name'
import { validateSecretName as checkSecretName } from './secret-name'
export function validateSecretName(name: unknown): asserts name is string {
  try {
    checkSecretName(name)
  } catch {
    throw new ProjectSecretError('invalid-secret')
  }
}
export function validateSecretValue(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > 65536 ||
    value.includes('\0')
  )
    throw new ProjectSecretError('invalid-secret')
}
/** Decode an allowlisted DTO, never echo arbitrary server fields. */
export function decodeSecretMetadata(raw: unknown): ProjectSecretMetadata {
  const r = raw as ProjectSecretMetadata
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.name !== 'string' ||
    typeof r.kind !== 'string' ||
    typeof r.owner !== 'string' ||
    Object.keys(r).length !== (r.warnings === undefined ? 8 : 9) ||
    Object.keys(r).some(
      (key) =>
        ![
          'name',
          'kind',
          'owner',
          'setAt',
          'fingerprint',
          'status',
          'failureCode',
          'lastSuppliedAt',
          'warnings',
        ].includes(key),
    ) ||
    (r.warnings !== undefined &&
      (!Array.isArray(r.warnings) || r.warnings.some((v) => v !== 'refresh-window-too-short'))) ||
    typeof r.setAt !== 'string' ||
    typeof r.fingerprint !== 'string' ||
    !(r.lastSuppliedAt === null || typeof r.lastSuppliedAt === 'string') ||
    !Number.isFinite(Date.parse(r.setAt)) ||
    !/^[a-f0-9]{16}$/.test(r.fingerprint) ||
    !['ready', 'refreshing', 'failed'].includes(r.status) ||
    !(r.failureCode === null || ['refresh-failed', 'refresh-expired'].includes(r.failureCode)) ||
    !(r.lastSuppliedAt === null || Number.isFinite(Date.parse(r.lastSuppliedAt)))
  )
    throw new ProjectSecretError('secret-unavailable')
  validateSecretName(r.name)
  return {
    name: r.name,
    kind: r.kind,
    owner: r.owner,
    setAt: r.setAt,
    fingerprint: r.fingerprint,
    status: r.status,
    failureCode: r.failureCode,
    lastSuppliedAt: r.lastSuppliedAt,
    ...(r.warnings === undefined ? {} : { warnings: [...r.warnings] }),
  }
}

export { chatgptStateSchema, credentialValues, type ChatGPTState } from './accounts/chatgpt-state'
export { refreshChatGPT } from './accounts/chatgpt-oauth'
