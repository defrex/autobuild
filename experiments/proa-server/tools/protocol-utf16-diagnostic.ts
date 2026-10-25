/** Regression entry retained from the original divergence investigation.
 * It now proves native/source equality; historical known-divergence evidence
 * belongs to its checkpoint, never to the current acceptance report. */
import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cachePath } from './verify'
import { buildProtocolExecutables } from './protocol-server-harness'
import { proveProtocolUnicode } from './protocol-unicode.integration.test'

export const diagnoseProtocolUtf16 = proveProtocolUnicode
if (import.meta.main) {
  const root = resolve(import.meta.dir, '../../..')
  const common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
  if (common.exitCode) throw new Error('Cannot resolve UTF16 regression Cargo cache')
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
    if (await child.exited) throw new Error('UTF16 regression proof failed')
  } else {
    const { server } = await buildProtocolExecutables({ ...process.env, CARGO_TARGET_DIR: target })
    const proof = await proveProtocolUnicode(server)
    const directory = resolve(root, '.ab/proa-protocol-utf16')
    await mkdir(directory, { recursive: true })
    await Bun.write(
      join(directory, 'conformance.json'),
      `${JSON.stringify({ unicodeParity: true, originalDivergencesResolved: true, proof }, null, 2)}\n`,
    )
    console.log(`UTF16 and HTTP UTF8 regressions match the source service: ${directory}`)
  }
}
