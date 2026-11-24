import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch: string[] = []
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

const root = join(import.meta.dir, '..', '..')
const authModule = join(root, 'app', 'api', 'auth', '[...all]', 'route.ts')
const dispatchModule = join(root, 'app', 'api', 'dispatch', 'route.ts')
const authMethods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']

describe('lazy API routes', () => {
  // One unconfigured subprocess loads both route modules: neither may fail at
  // import time, and each reports its own outcome so a failure names the route.
  test('the auth and dispatch routes load without configuration and refuse at request time', () => {
    const script = `
      const describeError = (error) => error instanceof Error ? error.message : String(error)
      const auth = { exported: [], failure: '' }
      try {
        const route = await import(${JSON.stringify(authModule)})
        auth.exported = ${JSON.stringify(authMethods)}.map((method) => typeof route[method])
        try {
          await route.GET(new Request('http://localhost/api/auth/get-session'))
        } catch (error) {
          auth.failure = describeError(error)
        }
      } catch (error) {
        auth.failure = 'import threw: ' + describeError(error)
      }
      const dispatch = { exported: '', status: '', kind: '' }
      try {
        const route = await import(${JSON.stringify(dispatchModule)})
        dispatch.exported = typeof route.GET
        const response = await route.GET(new Request('http://localhost/api/dispatch'))
        dispatch.status = String(response.status)
        dispatch.kind = String((await response.json()).kind)
      } catch (error) {
        dispatch.status = 'threw: ' + describeError(error)
      }
      console.log(JSON.stringify({ auth, dispatch }))
    `
    // A scratch cwd keeps Bun from auto-loading this checkout's .env files.
    const cwd = mkdtempSync(join(tmpdir(), 'ab-api-routes-'))
    scratch.push(cwd)
    const result = Bun.spawnSync(['bun', '-e', script], {
      cwd,
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const lines = result.stdout.toString().trim().split('\n')
    const output = JSON.parse(lines[lines.length - 1] ?? '{}') as {
      auth: { exported: string[]; failure: string }
      dispatch: { exported: string; status: string; kind: string }
    }
    // Auth: every method is exported, and the missing secret surfaces only
    // when a request arrives.
    expect(output.auth.exported).toEqual(authMethods.map(() => 'function'))
    expect(output.auth.failure).toContain('BETTER_AUTH_SECRET')
    // Dispatch: binds to the dispatcher package and does no work without
    // CRON_SECRET.
    expect(output.dispatch.exported).toBe('function')
    expect(output.dispatch).toMatchObject({ status: '403', kind: 'disabled' })
  })
})
