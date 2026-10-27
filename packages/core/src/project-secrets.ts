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
const reserved =
  /^(?:AB_|XDG_|BASH_|ZSH_|PYTHON|PERL|RUBY|GEM_|JAVA_|JDK_|_JAVA_|DOCKER_|KUBE|CARGO_|RUSTC_|RUSTUP_|GITHUB_|GH_|VERCEL_|CRON_|DATABASE_|POSTGRES_|PG|AWS_|AZURE_|GOOGLE_|GCP_|S3_|BLOB_|R2_|UPSTASH_|REDIS_|NEON_|SUPABASE_|BETTER_AUTH_|NEXT_|NPM_|npm_|BUN_|NODE_|LD_|DYLD_|GIT_|SSH_|SSL_|CURL_|HTTP_|HTTPS_|ALL_PROXY|NO_PROXY)/i
const processNames = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'SHELLOPTS',
  'BASHOPTS',
  'COMSPEC',
  'PATHEXT',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'MANPAGER',
  'LESSOPEN',
  'LESSCLOSE',
  'INPUTRC',
  'ENV',
  'BASH_ENV',
  'ZDOTDIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'PWD',
  'IFS',
  'CDPATH',
  'NODE_EXTRA_CA_CERTS',
])
export function validateSecretName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) ||
    reserved.test(name) ||
    processNames.has(name)
  )
    throw new ProjectSecretError('invalid-secret')
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
