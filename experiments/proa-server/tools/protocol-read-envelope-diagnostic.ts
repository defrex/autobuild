/** Historical CLI entry; the original differences are now equality proofs. */
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cachePath } from './verify'
import { buildProtocolExecutables } from './protocol-server-harness'
import { proveProtocolReadEnvelopes } from './protocol-read-envelopes.integration.test'
export { proveProtocolReadEnvelopes as diagnoseProtocolReadEnvelopes }
if (import.meta.main) {
  const root = resolve(import.meta.dir, '../../..')
  const common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
  if (common.exitCode) throw new Error('Cannot resolve read-envelope proof Cargo cache')
  const target =
    process.env.CARGO_TARGET_DIR ||
    process.env.PROA_VERIFY_CACHE ||
    cachePath(await realpath(resolve(root, common.stdout.toString().trim())))
  if (!process.argv.includes('--caller-holds-lock')) {
    await mkdir(target, { recursive: true })
    const child = Bun.spawn(
      ['flock', join(target, '.verify.lock'), 'bun', import.meta.filename, '--caller-holds-lock'],
      { env: { ...process.env, CARGO_TARGET_DIR: target }, stdout: 'inherit', stderr: 'inherit' },
    )
    if (await child.exited) throw new Error('Read-envelope proof failed')
  } else {
    const { server } = await buildProtocolExecutables({ ...process.env, CARGO_TARGET_DIR: target })
    const report = await proveProtocolReadEnvelopes(server)
    const directory = resolve(root, '.ab/proa-protocol-read-envelopes')
    await mkdir(directory, { recursive: true })
    await Bun.write(join(directory, 'read-envelopes.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Proved ${report.caseCount} read-envelope comparisons: ${directory}`)
  }
}
