import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..', '..')
const routeModule = join(root, 'app', 'api', 'auth', '[...all]', 'route.ts')
const methods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']

describe('web auth route', () => {
  test('loads without web configuration and defers the error to request time', () => {
    const script = `
      const route = await import(${JSON.stringify(routeModule)})
      const exported = ${JSON.stringify(methods)}.map((method) => typeof route[method])
      let failure = ''
      try {
        await route.GET(new Request('http://localhost/api/auth/get-session'))
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      console.log(JSON.stringify({ exported, failure }))
    `
    // A scratch cwd keeps Bun from auto-loading this checkout's .env files.
    const result = Bun.spawnSync(['bun', '-e', script], {
      cwd: mkdtempSync(join(tmpdir(), 'ab-auth-route-')),
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const lines = result.stdout.toString().trim().split('\n')
    const output = JSON.parse(lines[lines.length - 1] ?? '{}') as {
      exported: string[]
      failure: string
    }
    expect(output.exported).toEqual(methods.map(() => 'function'))
    expect(output.failure).toContain('BETTER_AUTH_SECRET')
  })
})
