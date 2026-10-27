import { AccessError } from '@defrex/autobuild-postgres-store/organizations'
import {
  ProjectSecretError,
  chatgptStateSchema,
  validateSecretName,
  validateSecretValue,
} from '@defrex/autobuild/project-secrets'
import type { ProjectSecretsManagement } from '@defrex/autobuild-postgres-store/project-secrets'
import { MachineAuthError, requireProjectOwner, type MachineAuth } from './machine-auth'
import {
  clientIdentityError,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
export function projectSecretsHandler(options: {
  auth: () => MachineAuth
  canAccess: (user: string, repo: string) => Promise<boolean>
  store: () => Promise<ProjectSecretsManagement>
}) {
  return async (request: Request): Promise<Response> => {
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
    try {
      const mismatch = clientIdentityError(
        request.headers.get(AUTOBUILD_VERSION_HEADER),
        request.headers.get(REMOTE_STORE_PROTOCOL_VERSION_HEADER),
      )
      if (mismatch) return json({ error: 'incompatible client', kind: 'conflict' }, 409)
      // Purpose and fresh membership are checked before reading any write body.
      const principal = requireProjectOwner(await options.auth().authenticate(request))
      if (!(await options.canAccess(principal.user, principal.repo)))
        throw new MachineAuthError(403, 'project membership required')
      const url = new URL(request.url)
      const operation = url.pathname.slice('/secrets/v1/'.length)
      if (operation === 'chatgpt-host' && request.method === 'GET') {
        if (url.searchParams.get('repo') !== principal.repo)
          throw new MachineAuthError(403, 'wrong project')
        const store = await options.store()
        if (!store.chatgptHost) return json({ error: 'provider unavailable' }, 503)
        return json({ version: 1, hostId: await store.chatgptHost(principal.repo) })
      }
      if (operation === 'list' && request.method === 'GET') {
        if (url.searchParams.get('repo') !== principal.repo)
          throw new MachineAuthError(403, 'wrong project')
        return json({ version: 1, secrets: await (await options.store()).list(principal.repo) })
      }
      if (!['set', 'remove', 'chatgpt'].includes(operation) || request.method !== 'POST')
        return json({ error: 'unknown secrets route' }, 404)
      const reader = request.body?.getReader()
      if (!reader) return json({ error: 'invalid secret request' }, 400)
      let bytes = 0
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.length
          if (bytes > 400_000) {
            await reader.cancel()
            return json({ error: 'secret request too large' }, 413)
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
        return json({ error: 'invalid secret request' }, 400)
      }
      const fields =
        operation === 'chatgpt'
          ? ['version', 'repo', 'name', 'state']
          : operation === 'set'
            ? ['version', 'repo', 'name', 'value']
            : ['version', 'repo', 'name']
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => !fields.includes(k)) ||
        Object.keys(body).length !== fields.length ||
        body.version !== 1
      )
        return json({ error: 'invalid secret request' }, 400)
      if (body.repo !== principal.repo) throw new MachineAuthError(403, 'wrong project')
      validateSecretName(body.name)
      const store = await options.store()
      if (operation === 'chatgpt') {
        const state = chatgptStateSchema.safeParse(body.state)
        if (!state.success || !store.setChatGPT)
          return json({ error: 'invalid ChatGPT registration' }, 400)
        await store.setChatGPT(principal.repo, body.name, state.data, principal.user)
      } else if (operation === 'set') {
        validateSecretValue(body.value)
        await store.set(principal.repo, body.name, body.value, principal.user)
      } else await store.remove(principal.repo, body.name, principal.user)
      return json({ version: 1, ok: true })
    } catch (error) {
      if (error instanceof MachineAuthError || error instanceof AccessError)
        return json({ error: error.message, kind: 'auth' }, error.status)
      if (error instanceof ProjectSecretError)
        return json(
          { error: error.message, kind: error.code },
          error.code === 'invalid-secret' ? 400 : 503,
        )
      // Do not forward request/parser/provider/crypto failures to generic reporters.
      return json({ error: 'project secrets unavailable', kind: 'internal' }, 503)
    }
  }
}
