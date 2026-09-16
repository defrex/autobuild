import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..', '..')
const routeModule = join(root, 'app', 'api', 'dispatch', 'route.ts')

describe('dispatch cron route', () => {
  test('binds to the dispatcher package and does no work without CRON_SECRET', () => {
    const script = `
      const route = await import(${JSON.stringify(routeModule)})
      const exported = typeof route.GET
      let status = ''
      let kind = ''
      try {
        const response = await route.GET(new Request('http://localhost/api/dispatch'))
        status = String(response.status)
        kind = String((await response.json()).kind)
      } catch (error) {
        status = 'threw: ' + (error instanceof Error ? error.message : String(error))
      }
      console.log(JSON.stringify({ exported, status, kind }))
    `
    // A scratch cwd keeps Bun from auto-loading this checkout's .env files.
    const result = Bun.spawnSync(['bun', '-e', script], {
      cwd: mkdtempSync(join(tmpdir(), 'ab-dispatch-route-')),
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const lines = result.stdout.toString().trim().split('\n')
    const output = JSON.parse(lines[lines.length - 1] ?? '{}') as {
      exported: string
      status: string
      kind: string
    }
    expect(output.exported).toBe('function')
    expect(output.status).toBe('403')
    expect(output.kind).toBe('disabled')
  })
})
