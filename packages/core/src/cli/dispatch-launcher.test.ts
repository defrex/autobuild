import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distributionPath } from '../distribution'
import { openLocalStore } from '../store/local/store'
import { GENERATION_SIGNALS } from './dispatch-launch-contract'

for (const signal of GENERATION_SIGNALS)
  test(`production launcher drains ${signal} and records the original signal`, async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'ab-launch-signals-'))
    const storePath = join(checkout, '.autobuild', 'store')
    const store = openLocalStore(storePath)
    await mkdir(join(checkout, 'tickets/ready'), { recursive: true })
    await writeFile(
      join(checkout, 'autobuild.toml'),
      'forge = "local-git"\n[roles.default]\nruntime = "claude"\n[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
    )
    const child = Bun.spawn(
      [
        process.execPath,
        distributionPath('bin/ab.ts'),
        'dispatch',
        '--plain',
        '--interval',
        '0.02',
        '--store',
        storePath,
      ],
      {
        cwd: checkout,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AB_DISPATCH_GENERATION: JSON.stringify({
            version: 999,
            runtimeRoot: '/wrong',
            checkout: '/wrong',
          }),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const stdout = new Response(child.stdout).text(),
      stderr = new Response(child.stderr).text()
    try {
      const deadline = Date.now() + 30000
      for (;;) {
        const repo = await store.getRepo(checkout)
        if (
          repo &&
          (await store.getRepoEvents(checkout)).some(
            (e) => e.type === 'dispatcher.runtime-recorded',
          )
        )
          break
        if (child.exitCode !== null) throw new Error(await stderr)
        if (Date.now() > deadline) throw new Error('dispatcher did not start')
        await Bun.sleep(20)
      }
      child.kill(signal)
      await child.exited
      const events = await store.getRepoEvents(checkout)
      expect(events.find((e) => e.type === 'dispatcher.run-stopped')?.payload).toMatchObject({
        outcome: 'normal',
        signal,
      })
      if (signal === 'SIGINT') expect(child.exitCode).toBe(0)
      else expect(child.signalCode).toBe(signal)
      expect(await stderr).toBe('')
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGINT')
        await child.exited
      }
      await stdout
      await store.close()
      await rm(checkout, { recursive: true, force: true })
    }
  }, 45000)

test('public inherited markers cannot bypass routing; hot renderer keeps the direct seam', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'ab-launch-routing-'))
  try {
    const code = `import {runBinary} from ${JSON.stringify(distributionPath('packages/core/src/cli/binary.ts'))}; const code=await runBinary(['dispatch'],()=>()=>[]); if(process.env.AB_DISPATCH_GENERATION) throw new Error('marker leaked'); process.exit(code);`
    const child = Bun.spawn([process.execPath, '--eval', code], {
      cwd: checkout,
      env: { PATH: process.env.PATH, AB_DISPATCH_GENERATION: 'malformed' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('autobuild.toml')
    await expect(access(join(checkout, '.autobuild/runtime'))).rejects.toThrow()
    const invalid = Bun.spawn(
      [process.execPath, distributionPath('bin/ab-dispatch-generation.ts'), '--version'],
      {
        env: { PATH: process.env.PATH, AB_DISPATCH_GENERATION: 'malformed' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(await invalid.exited).toBe(82)
    expect(await new Response(invalid.stderr).text()).not.toBe('')
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
})
