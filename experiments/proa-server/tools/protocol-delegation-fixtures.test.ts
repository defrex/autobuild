import { test, expect } from 'bun:test'
import { resolve } from 'node:path'
for (const name of [
  'protocol-delegation-fixtures.ts',
  'protocol-delegation-authority-fixtures.ts',
]) {
  test(`${name} matches authoritative TypeScript`, async () => {
    const process = Bun.spawn(['bun', resolve(import.meta.dir, name)], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await process.exited
    expect(await new Response(process.stderr).text()).toBe('')
    expect(code).toBe(0)
  })
}
