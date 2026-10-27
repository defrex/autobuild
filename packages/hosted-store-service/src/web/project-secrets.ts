import type { BuildStore } from '@defrex/autobuild/store-adapter'
import { effectiveConfig } from '@defrex/autobuild/operator'
import {
  decodeSecretMetadata,
  ProjectSecretError,
  validateSecretName,
  validateSecretValue,
  SECRET_NAME_EXPLANATION,
} from '@defrex/autobuild/project-secrets'
import {
  StaticSecretConflictError,
  type ProjectSecretsManagement,
} from '@defrex/autobuild-postgres-store/project-secrets'
import type { ProjectRegistryReader } from '@defrex/autobuild-postgres-store/projects'
import { type HumanAccess, validSession } from './access'
import type { GatewaySession } from './gateway'
import { normalizeEmail } from './config'

export interface ProjectSettings {
  secrets: ReturnType<typeof decodeSecretMetadata>[]
  configuration: 'available' | 'no-dispatcher' | 'unavailable'
  accounts: { name: string; kind: string; credentialEnv: string; ready: boolean }[]
}
export function createWebProjectSecretsHandler(options: {
  access: Pick<HumanAccess, 'principal' | 'canAccess'>
  projects: ProjectRegistryReader
  baseURL: string
  getSession: (headers: Headers) => Promise<GatewaySession | null>
  secrets: () => Promise<ProjectSecretsManagement>
  store: () => Promise<BuildStore>
}) {
  return async (request: Request): Promise<Response> => {
    const json = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: {
          'cache-control': 'private, no-store',
          pragma: 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        },
      })
    const fail = (error: string, status = 503) => json({ error }, status)
    try {
      const session = await options.getSession(request.headers)
      if (!validSession(session)) return fail('Sign in required.', 401)
      const actor = await options.access.principal(normalizeEmail(session!.user.email))
      if (!actor) return fail('Project membership required.', 403)
      const parts = new URL(request.url).pathname.split('/').slice(4).map(decodeURIComponent)
      const [repo, resource, operation] = parts
      if (!repo || resource !== 'secrets' || parts.length > 3)
        return fail('Unknown secrets route.', 404)
      if (!(await options.projects.has(repo)) || !(await options.access.canAccess(actor, repo)))
        return fail('Unknown project.', 404)
      if (request.method === 'GET' && !operation) {
        const secrets = (await (await options.secrets()).list(repo)).map(decodeSecretMetadata)
        let configuration: ProjectSettings['configuration'] = 'available'
        let accounts: ProjectSettings['accounts'] = []
        try {
          const { config } = await effectiveConfig(await options.store(), repo)
          accounts = Object.entries(config.accounts).map(([name, account]) => ({
            name,
            kind: account.kind,
            credentialEnv: account.credentialEnv,
            ready: secrets.some((s) => s.name === account.credentialEnv && s.status === 'ready'),
          }))
        } catch (error) {
          configuration =
            error instanceof Error && error.message.endsWith(': no dispatcher run is recorded')
              ? 'no-dispatcher'
              : 'unavailable'
        }
        return json({ secrets, configuration, accounts } satisfies ProjectSettings)
      }
      if (request.method !== 'POST' || !['set', 'remove'].includes(operation ?? ''))
        return fail('Unknown secrets route.', 404)
      if (request.headers.get('origin') !== options.baseURL)
        return fail('Cross-origin write refused.', 403)
      if (
        request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
      )
        return fail('Writes require application/json.', 400)
      const reader = request.body?.getReader()
      if (!reader) return fail('Invalid secret request.', 400)
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > 400_000) {
            await reader.cancel()
            return fail('Secret request too large.', 413)
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(Buffer.concat(chunks).toString())
      } catch {
        return fail('Invalid secret request.', 400)
      }
      const fields = operation === 'set' ? ['name', 'value'] : ['name']
      if (
        !body ||
        Array.isArray(body) ||
        typeof body !== 'object' ||
        Object.keys(body).length !== fields.length ||
        Object.keys(body).some((k) => !fields.includes(k))
      )
        return fail('Invalid secret request.', 400)
      try {
        validateSecretName(body.name)
      } catch {
        return fail(SECRET_NAME_EXPLANATION, 400)
      }
      if (operation === 'set') {
        try {
          validateSecretValue(body.value)
        } catch {
          return fail('Enter a nonempty value of at most 65536 bytes without NUL characters.', 400)
        }
        const store = await options.secrets()
        if (!store.setStaticOnly) return fail('Browser secret writes are unavailable.')
        await store.setStaticOnly(repo, body.name, body.value, actor.email)
      } else await (await options.secrets()).remove(repo, body.name, actor.email)
      return json({ ok: true })
    } catch (error) {
      if (error instanceof StaticSecretConflictError)
        return fail(
          'Refreshing credentials must be renewed with ab accounts login <account> --project.',
          409,
        )
      if (error instanceof ProjectSecretError && error.code === 'key-unavailable')
        return fail(
          'The service’s project-secret encryption key is not configured or usable. An administrator must fix it.',
        )
      return fail('Project secrets are unavailable. Try again later.')
    }
  }
}
