import { expect, test } from 'bun:test'
import { routeWebRequest } from './runtime'
import { hostedProjectContext } from '@defrex/autobuild-postgres-store/request-context'

test('runtime routes browser secrets separately with project lifecycle admission context', async () => {
  const called: string[] = []
  const handlers = {
    projectSecrets: async (request: Request) => {
      expect(hostedProjectContext()).toBeDefined()
      called.push('secrets')
      return Response.json({ method: request.method })
    },
    management: async () => {
      called.push('management')
      return Response.json({})
    },
    operator: async () => {
      called.push('operator')
      return Response.json({})
    },
  }
  for (const suffix of ['secrets', 'secrets/set', 'secrets/remove']) {
    const response = await routeWebRequest(
      new Request(
        `https://operator.example/api/web/repos/https%3A%2F%2Fgithub.com%2Fexample%2Frepo/${suffix}`,
      ),
      handlers,
    )
    expect(response.status).toBe(200)
  }
  await routeWebRequest(new Request('https://operator.example/api/web/orgs'), handlers)
  await routeWebRequest(
    new Request('https://operator.example/api/web/repos/repo/dashboard'),
    handlers,
  )
  await routeWebRequest(
    new Request('https://operator.example/api/web/repos/repo/secrets-other'),
    handlers,
  )
  expect(called).toEqual(['secrets', 'secrets', 'secrets', 'management', 'operator', 'operator'])
  expect(hostedProjectContext()).toBeUndefined()
})
