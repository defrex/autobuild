import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function verifyDistribution(version: string, fixture: string, success: string) {
  const root = resolve(import.meta.dir, '../../..')
  const temp = await mkdtemp(join(tmpdir(), 'ab-beta-service-'))
  try {
    await cp(join(root, 'packages'), join(temp, 'packages'), {
      recursive: true,
      filter: (path) => !path.split('/').includes('node_modules'),
    })
    const manifest = await Bun.file(join(root, 'package.json')).json()
    manifest.version = version
    await writeFile(join(temp, 'package.json'), JSON.stringify(manifest))
    await mkdir(join(temp, 'node_modules/@defrex'), { recursive: true })
    for (const name of await readdir(join(root, 'node_modules'))) {
      if (name === '@defrex') continue
      await symlink(join(root, 'node_modules', name), join(temp, 'node_modules', name))
    }
    for (const name of [
      'core',
      'postgres-store',
      'hosted-store-service',
      'vercel-sandbox',
      'hosted-dispatcher',
    ]) {
      const deps = join(root, 'packages', name, 'node_modules')
      const dest = join(temp, 'packages', name, 'node_modules')
      await mkdir(dest, { recursive: true })
      for (const dependency of await readdir(deps)) {
        if (dependency === '@defrex') continue
        await symlink(join(deps, dependency), join(dest, dependency))
      }
    }
    await symlink(temp, join(temp, 'node_modules/@defrex/autobuild'))
    for (const name of [
      'postgres-store',
      'hosted-store-service',
      'vercel-sandbox',
      'hosted-dispatcher',
    ]) {
      await symlink(
        join(temp, 'packages', name),
        join(temp, 'node_modules/@defrex', `autobuild-${name}`),
      )
    }
    const child = Bun.spawn(
      [process.execPath, join(temp, 'packages/hosted-store-service/src/testing', fixture)],
      {
        cwd: temp,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const timer = setTimeout(() => child.kill(), 30_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, output: stdout + stderr }).toMatchObject({
        code: 0,
        output: expect.stringContaining(success),
      })
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

test('prerelease distribution serves health, store, tickets and operator routes', async () => {
  await verifyDistribution('1.4.0-beta.1', 'prerelease-service.ts', 'beta service verified')
}, 60_000)

test('current service refuses pre-floor clients and preserves supported audit capability', async () => {
  await verifyDistribution('1.3.0', 'audit-capability-service.ts', 'audit service verified')
}, 60_000)
