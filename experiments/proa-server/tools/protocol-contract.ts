/** Explicit complete shared-contract runner. Never silently skips PostgreSQL. */
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { strict as assert } from 'node:assert'
import { cachePath } from './verify'
import { buildProtocolExecutables } from './protocol-server-harness'
import { isolatedEnvironment, administrativeUrl } from './data-services'

const root = resolve(import.meta.dir, '../../..')
async function run() {
  const common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
  if (common.exitCode) throw new Error('Cannot resolve contract Cargo cache')
  const target =
    process.env.CARGO_TARGET_DIR ||
    process.env.PROA_VERIFY_CACHE ||
    cachePath(await realpath(resolve(root, common.stdout.toString().trim())))
  const environment = { ...process.env, CARGO_TARGET_DIR: target }
  if (!process.argv.includes('--caller-holds-lock')) {
    await mkdir(target, { recursive: true })
    const child = Bun.spawn(
      ['flock', join(target, '.verify.lock'), 'bun', import.meta.filename, '--caller-holds-lock'],
      { env: environment, stdout: 'inherit', stderr: 'inherit' },
    )
    if (await child.exited) throw new Error('Full Rust BuildStore contract failed')
    return
  }
  const { server } = await buildProtocolExecutables(environment)
  const evidence = resolve(root, '.ab/proa-protocol-contract')
  await mkdir(evidence, { recursive: true })
  const factoryReport = join(evidence, 'factory-lifecycle.json'),
    logPath = join(evidence, 'bun-test.log')
  // Validate any explicitly selected fixture target before handing it to child.
  const selected = administrativeUrl(process.env)
  await rm(factoryReport, { force: true })
  const child = Bun.spawn(
    [
      'bun',
      'test',
      resolve(import.meta.dir, 'protocol-contract.integration.test.ts'),
      '--timeout',
      '60000',
    ],
    {
      cwd: root,
      env: {
        ...isolatedEnvironment(),
        AB_POSTGRES_TEST_URL: selected.explicit ? selected.url : undefined,
        PROA_RUN_FULL_CONTRACT: '1',
        PROA_PROTOCOL_EXECUTABLE: server,
        PROA_PROTOCOL_CONTRACT_FACTORY_REPORT: factoryReport,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const writer = Bun.file(logPath).writer()
  let output = ''
  const copy = async (
    stream: ReadableStream<Uint8Array>,
    dest: { write(bytes: Uint8Array): unknown },
  ) => {
    for await (const bytes of stream) {
      writer.write(bytes)
      dest.write(bytes)
      output += new TextDecoder().decode(bytes)
    }
  }
  await Promise.all([copy(child.stdout, process.stdout), copy(child.stderr, process.stderr)])
  const exitCode = await child.exited
  await writer.end()
  const count = (name: string) =>
    Number(output.match(new RegExp(`(?:^|\\n)\\s*(\\d+) ${name}\\s*(?:\\n|$)`))?.[1] ?? 0)
  const passed = count('pass'),
    failed = count('fail'),
    skipped = count('skip')
  const factory = await Bun.file(factoryReport)
    .json()
    .catch(() => ({ factoryCalls: 0, cleanups: 0, openFactories: -1 }))
  const green =
    exitCode === 0 &&
    passed > 100 &&
    failed === 0 &&
    skipped === 0 &&
    factory.factoryCalls > 0 &&
    factory.factoryCalls === factory.cleanups &&
    factory.openFactories === 0
  await Bun.write(
    join(evidence, 'report.json'),
    `${JSON.stringify({ fullBuildStoreContract: green, exitCode, passed, failed, skipped, ...factory, logPath }, null, 2)}\n`,
  )
  assert.ok(green, `Full unchanged Rust contract did not pass without skips; see ${logPath}`)
  console.log(
    `Complete unchanged Rust BuildStore contract passed: ${passed} tests, no skips. Evidence: ${evidence}`,
  )
}
if (import.meta.main) await run()
