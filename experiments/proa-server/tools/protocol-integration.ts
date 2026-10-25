import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cachePath } from './verify'
import { buildProtocolExecutables } from './protocol-server-harness'
import { buildCredentialHelper } from './protocol-credentials'
import { runCredentialHttpProof, runCredentialProof } from './protocol-credentials.integration.test'
import { proveProtocolStore } from './protocol-store.integration.test'
import { proveProtocolSessions } from './protocol-sessions.integration.test'
import { proveProtocolSnapshotsPresence } from './protocol-snapshots-presence.integration.test'
import { proveProtocolJson } from './protocol-json.integration.test'
import { protocolBlobInteroperability } from './protocol-blobs.integration.test'
import { proveProtocolTicks } from './protocol-ticks.integration.test'
import { proveProtocolArtifactBoundaries } from './protocol-artifact-boundaries.integration.test'
import { proveProtocolArtifacts } from './protocol-artifacts.integration.test'
import { proveProtocolEvents } from './protocol-events.integration.test'
import { withDataServices } from './data-services'

const root = resolve(import.meta.dir, '../../..')
const common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], { cwd: root })
if (common.exitCode) throw new Error('Cannot resolve protocol integration Cargo cache')
const target =
  process.env.CARGO_TARGET_DIR ||
  process.env.PROA_VERIFY_CACHE ||
  cachePath(await realpath(resolve(root, common.stdout.toString().trim())))
const environment = { ...process.env, CARGO_TARGET_DIR: target }
if (!process.argv.includes('--caller-holds-lock')) {
  await mkdir(target, { recursive: true })
  // Only this outer process acquires the lock. All descendants compile under it.
  const child = Bun.spawn(
    ['flock', join(target, '.verify.lock'), 'bun', import.meta.filename, '--caller-holds-lock'],
    { env: environment, stdout: 'inherit', stderr: 'inherit' },
  )
  if ((await child.exited) !== 0) throw new Error('Protocol integration failed')
} else {
  const { server, blob } = await buildProtocolExecutables(environment)
  const credential = await buildCredentialHelper(environment)
  await withDataServices(async (admin, env) => {
    await runCredentialProof(credential, admin, env)
    await runCredentialHttpProof(server, admin, env)
  })
  const json = await proveProtocolJson(server)
  const blobs = await protocolBlobInteroperability(blob)
  const ticks = await proveProtocolTicks(server)
  const records = await proveProtocolStore(server)
  const sessions = await proveProtocolSessions(server)
  const events = await proveProtocolEvents(server)
  const artifactBoundaries = await proveProtocolArtifactBoundaries(server)
  const artifacts = await proveProtocolArtifacts(server)
  const snapshotsPresence = await proveProtocolSnapshotsPresence(server)
  const evidence = resolve(root, '.ab/proa-protocol-store')
  await mkdir(evidence, { recursive: true })
  await Bun.write(
    join(evidence, 'checkpoint-proof.json'),
    `${JSON.stringify({ fullBuildStoreContract: false, records, sessions, events, artifacts, artifactBoundaries, ticks, blobs, json, snapshotsPresence }, null, 2)}\n`,
  )
  console.log(
    `Native protocol checkpoint proof passed; complete shared suite remains required. Evidence: ${evidence}`,
  )
}
