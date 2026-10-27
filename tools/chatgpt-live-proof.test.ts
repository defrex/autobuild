import { describe, expect, test } from 'bun:test'
import { createProofSandbox, deleteProofSandbox } from './chatgpt-live-proof'

describe('ChatGPT live proof sandbox lifecycle', () => {
  test('passes explicit project credentials to the authenticated SDK client', async () => {
    let received: unknown
    const create = (async (options: unknown) => {
      received = options
      return {} as never
    }) as Parameters<typeof createProofSandbox>[3]
    await createProofSandbox(
      'allow-all',
      60000,
      {
        VERCEL_TOKEN: 'test-token',
        VERCEL_TEAM_ID: 'test-team',
        VERCEL_PROJECT_ID: 'test-project',
      },
      create,
    )
    expect(received).toEqual({
      token: 'test-token',
      teamId: 'test-team',
      projectId: 'test-project',
      runtime: 'node24',
      timeout: 60000,
      networkPolicy: 'allow-all',
    })
  })

  test('reports deletion only after stop and successful delete', async () => {
    const calls: string[] = []
    const pass = await deleteProofSandbox(
      {
        stop: async () => {
          calls.push('stop')
          return {} as never
        },
        delete: async () => {
          calls.push('delete')
        },
      },
      (name, ok) => calls.push(`${ok} ${name}`),
    )
    expect(pass).toBe(true)
    expect(calls).toEqual(['stop', 'delete', 'true sandbox-deleted'])
  })

  test.each(['stop', 'delete'])(
    'fails closed when %s fails and still attempts delete',
    async (failure) => {
      const calls: string[] = []
      const pass = await deleteProofSandbox(
        {
          stop: async () => {
            calls.push('stop')
            if (failure === 'stop') throw new Error('private diagnostic')
            return {} as never
          },
          delete: async () => {
            calls.push('delete')
            if (failure === 'delete') throw new Error('private diagnostic')
          },
        },
        (name, ok) => calls.push(`${ok} ${name}`),
      )
      expect(pass).toBe(false)
      expect(calls).toEqual(['stop', 'delete', 'false sandbox-deleted'])
    },
  )
})
