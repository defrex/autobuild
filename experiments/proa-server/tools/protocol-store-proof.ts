import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cachePath } from './verify'
import { buildProtocolExecutables, buildProtocolExecutablesLocked } from './protocol-server-harness'
import { proveProtocolStore } from './protocol-store.integration.test'

const root = resolve(import.meta.dir, '../../..')
const common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
if (common.exitCode) throw new Error('Cannot resolve protocol proof cache')
const target =
  process.env.CARGO_TARGET_DIR ||
  process.env.PROA_VERIFY_CACHE ||
  cachePath(await realpath(resolve(root, common.stdout.toString().trim())))
const environment = { ...process.env, CARGO_TARGET_DIR: target }
// The maintained gate already owns flock. Standalone callers acquire it here;
// never infer lock ownership merely because CARGO_TARGET_DIR was supplied.
const { server } = await (process.argv.includes('--caller-holds-lock')
  ? buildProtocolExecutables
  : buildProtocolExecutablesLocked)(environment)
const report = await proveProtocolStore(server)
const evidence = resolve(root, '.ab/proa-protocol-store')
await mkdir(evidence, { recursive: true })
await Bun.write(join(evidence, 'record-lease-proof.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(
  `Protocol record/lease checkpoint passed: ${report.checks.length} groups; full shared contract NOT claimed; evidence ${evidence}`,
)
