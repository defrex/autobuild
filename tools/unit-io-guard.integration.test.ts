import { describe, expect, test } from 'bun:test'
import { checkoutRoot, suiteCommands, UNIT_IO_GUARD_PRELOAD } from './test-temp-leaks'

async function runUnderUnitGuard(fixture: string): Promise<{ code: number; output: string }> {
  const [unit] = await suiteCommands('unit', [])
  const preload = unit?.indexOf(`--preload=${UNIT_IO_GUARD_PRELOAD}`) ?? -1
  expect(preload).toBeGreaterThan(0)
  const child = Bun.spawn([...(unit ?? []).slice(0, preload + 1), fixture], {
    cwd: checkoutRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, output: stdout + stderr }
}

describe('unit IO guard enforcement', () => {
  test('fails every deliberately offending unit test and names the call', async () => {
    const { code, output } = await runUnderUnitGuard('./tools/fixtures/unit-io-offender.fixture.ts')
    expect(code).not.toBe(0)
    for (const name of [
      'fs.readFileSync',
      'Bun.spawnSync',
      'fetch',
      'setTimeout',
      'net.Socket#connect',
      'timers/promises.setTimeout',
      'Atomics.wait',
      'net.Server#listen',
    ])
      expect(output).toContain(`Unit tests must not do IO: ${name} (`)
    for (const name of [
      'swallowed readFileSync',
      'Bun.spawnSync',
      'fetch',
      'delayed setTimeout',
      'swallowed Socket#connect',
      'timers/promises setTimeout',
      'swallowed Atomics.wait',
      'Server#listen',
    ])
      expect(output).toContain(`(fail) unit IO offender > ${name}`)
    expect(output).toContain(' 0 pass')
    expect(output).toContain(' 8 fail')
    expect(output).toContain('*.integration.test.ts')
  }, 30_000)

  test('fails import-time IO in a file whose tests are all skipped', async () => {
    const { code, output } = await runUnderUnitGuard('./tools/fixtures/unit-io-skipped.fixture.ts')
    expect(code).not.toBe(0)
    expect(output).toContain(
      'Unit tests must not do IO: fs.readFileSync (filesystem) at tools/fixtures/unit-io-skipped.fixture.ts:',
    )
    expect(output).toContain('*.integration.test.ts')
  }, 30_000)
})
