import { mkdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cachePath } from './verify'
import { buildProtocolExecutables } from './protocol-server-harness'
import { buildCredentialHelper } from './protocol-credentials'
import { runCredentialHttpProof, runCredentialProof } from './protocol-credentials.integration.test'
import { proveProtocolDelegatedDispatch } from './protocol-dispatch.integration.test'
import { proveProtocolDelegation } from './protocol-delegation.integration.test'
import { proveProtocolDelegationAuthority } from './protocol-delegation-authority.integration.test'
import { proveProtocolCompatibility } from './protocol-compatibility.integration.test'
import { proveProtocolReducers } from './protocol-reducers.integration.test'
import { proveProtocolAssets } from './protocol-assets.integration.test'
import { proveProtocolStreams } from './protocol-streams.integration.test'
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
import { beginProtocolCoverage } from './protocol-route-coverage'
import { proveProtocolRouteAliases } from './protocol-route-aliases.integration.test'

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
  const { server, blob, reader } = await buildProtocolExecutables(environment)
  const credential = await buildCredentialHelper(environment)
  const coverage = beginProtocolCoverage()
  await coverage.proof('credentials', () =>
    withDataServices(async (admin, env) => {
      await runCredentialProof(credential, admin, env)
      await runCredentialHttpProof(server, admin, env)
    }),
  )
  const delegation = await coverage.proof('delegation', () => proveProtocolDelegation(server))
  const authority = await coverage.proof('authority', () =>
    proveProtocolDelegationAuthority(server),
  )
  const compatibility = await coverage.proof('compatibility', () =>
    proveProtocolCompatibility(server),
  )
  const dispatch = await coverage.proof('dispatch', () =>
    proveProtocolDelegatedDispatch(server, reader),
  )
  const json = await coverage.proof('json', () => proveProtocolJson(server))
  const blobs = await protocolBlobInteroperability(blob)
  const ticks = await coverage.proof('ticks', () => proveProtocolTicks(server))
  const reducers = await coverage.proof('reducers', () => proveProtocolReducers(server))
  const assets = await coverage.proof('assets', () => proveProtocolAssets(server))
  const streams = await coverage.proof('streams', () => proveProtocolStreams(server))
  const records = await coverage.proof('records', () => proveProtocolStore(server))
  const sessions = await coverage.proof('sessions', () => proveProtocolSessions(server))
  const events = await coverage.proof('events', () => proveProtocolEvents(server))
  const artifactBoundaries = await coverage.proof('artifactBoundaries', () =>
    proveProtocolArtifactBoundaries(server),
  )
  const artifacts = await coverage.proof('artifacts', () => proveProtocolArtifacts(server))
  const snapshotsPresence = await coverage.proof('snapshotsPresence', () =>
    proveProtocolSnapshotsPresence(server),
  )
  const routeAliases = await coverage.proof('route-aliases', () =>
    proveProtocolRouteAliases(server),
  )
  const routeCoverage = coverage.assertComplete()
  const evidence = resolve(root, '.ab/proa-protocol-store')
  await mkdir(evidence, { recursive: true })
  await Bun.write(
    join(evidence, 'checkpoint-proof.json'),
    `${JSON.stringify({ includesFullBuildStoreContract: false, fullContractReport: '.ab/proa-protocol-contract/report.json', routeCoverage, routeAliases, delegation, authority, compatibility, dispatch, assets, streams, reducers, records, sessions, events, artifacts, artifactBoundaries, ticks, blobs, json, snapshotsPresence }, null, 2)}\n`,
  )
  console.log(
    `Native protocol family proofs passed; unchanged suite evidence is recorded separately by protocol-contract.ts. Evidence: ${evidence}`,
  )
}
