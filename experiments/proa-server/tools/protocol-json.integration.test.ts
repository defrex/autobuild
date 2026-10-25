/** Raw JSON numeric edge proof, explicitly invoked by the protocol gate.
 * The request bodies deliberately bypass JSON.stringify: it would round unsafe
 * literals and turn nonfinite numbers into null before Rust ever sees them. */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { sampleEventWrite, harvestStartedWrite } from '../../../packages/core/src/store/contract'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  AUTOBUILD_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION,
} from '../../../packages/core/src/store/remote/version'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

const literals = [
  '9007199254740993',
  '-9007199254740993',
  '18446744073709551615',
  '-18446744073709551615',
  '0.9999999999999999',
  '9007199254740993.0',
  '1000000000000000100',
  '1.234567890123456789',
  '1.0000000000000001',
  '1.00000000000000011102230246251565404236316680908203125',
  '1.00000000000000011102230246251565404236316680908203126',
  '0.1000000000000000055511151231257827021181583404541015625',
  '1e20',
  '1e21',
  '2.2250738585072012e-308',
  '2.4703282292062327e-324',
  '2.4703282292062328e-324',
  '1e-400',
  '-1e-400',
  '-0',
  '1e400',
  '-1e400',
]

export async function proveProtocolJson(executable: string) {
  const checks: string[] = []
  let comparisons = 0
  await withDataServices(async (admin, environment) => {
    await withProtocolDatabase(admin, environment, async (env) => {
      const clock = () => new Date('2030-01-01T00:00:00.000Z')
      const ts = await openPostgresBuildStoreFromEnv(env, { clock })
      const inspect = new SQL(env.AB_POSTGRES_URL!, { max: 1 })
      let server: Awaited<ReturnType<typeof startProtocolServer>> | undefined
      let failure: unknown
      try {
        server = await startProtocolServer({ executable, env, clock })
        const native = server
        const oracle = createStoreServer({ store: ts, clock, maxArtifactBytes: 1024 * 1024 })
        const headers = {
          'content-type': 'application/json',
          'x-autobuild-version': AUTOBUILD_VERSION,
          'x-autobuild-protocol-version': REMOTE_STORE_PROTOCOL_VERSION,
        }
        async function compare(path: string, method: string, body?: string) {
          const init = { method, headers, ...(body === undefined ? {} : { body }) }
          const actual = await native.fetch(
            `${native.url}${path.replaceAll('SIDE', 'native')}`,
            init,
          )
          const expected = await oracle.fetch(
            new Request(`http://oracle${path.replaceAll('SIDE', 'oracle')}`, init),
          )
          const actualText = (await actual.text()).replaceAll('numeric-native-', 'numeric-SIDE-')
          const expectedText = (await expected.text()).replaceAll(
            'numeric-oracle-',
            'numeric-SIDE-',
          )
          assert.equal(
            actual.status,
            expected.status,
            `${method} ${path}: ${actualText} / ${expectedText}`,
          )
          assert.deepEqual(JSON.parse(actualText), JSON.parse(expectedText), `${method} ${path}`)
          comparisons++
          return { actualText, expectedText, status: actual.status }
        }
        for (const [index, literal] of literals.entries()) {
          const slug = `numeric-SIDE-${index}`
          await ts.createBuild({
            slug: slug.replace('SIDE', 'native'),
            repo: 'numeric-native-repo',
          })
          await ts.createBuild({
            slug: slug.replace('SIDE', 'oracle'),
            repo: 'numeric-oracle-repo',
          })
          // An unknown metadata branch is accepted even when its parsed number
          // is infinite; JSON.stringify at the persistence/wire boundary maps it
          // to null. Nested arrays ensure normalization is recursive.
          const metadata = `{"n":${literal},"nested":{"n":${literal}},"list":[${literal}]}`
          const artifact = await compare(
            `/builds/${slug}/artifacts`,
            'POST',
            `{"kind":"numeric","contentBase64":"YQ==","metadata":${metadata}}`,
          )
          assert.equal(artifact.status, 201, `artifact unknown metadata ${literal}`)
          const actualToken = artifact.actualText.match(/"n":([^,}\]]+)/)?.[1]
          const expectedToken = artifact.expectedText.match(/"n":([^,}\]]+)/)?.[1]
          assert.ok(actualToken && expectedToken, 'artifact raw numeric response token exists')
          // Checking parsed JS numbers alone would hide an unrounded Rust i64.
          // Check the exact raw token, including JS shortest-decimal/exponent style.
          assert.equal(actualToken, expectedToken, `raw artifact numeric precision ${literal}`)
          assert.equal(
            expectedToken,
            JSON.stringify(Number(literal)),
            `TypeScript raw number oracle ${literal}`,
          )
          assert.equal((await compare(`/builds/${slug}/artifacts?kind=numeric`, 'GET')).status, 200)
          const rows =
            await inspect`SELECT build,metadata->>'n' AS n,metadata#>>'{nested,n}' AS nested,metadata#>>'{list,0}' AS listed FROM artifacts WHERE build IN (${slug.replace('SIDE', 'native')},${slug.replace('SIDE', 'oracle')}) AND kind='numeric' ORDER BY build`
          assert.equal(rows.length, 2)
          assert.deepEqual(
            { n: rows[0]!.n, nested: rows[0]!.nested, listed: rows[0]!.listed },
            { n: rows[1]!.n, nested: rows[1]!.nested, listed: rows[1]!.listed },
            `SQL exact metadata JSONB numeric text ${literal}`,
          )

          assert.equal(
            (
              await compare(
                `/builds/${slug}/snapshots/numeric`,
                'PUT',
                `{"version":1,"cursor":0,"state":${metadata}}`,
              )
            ).status,
            200,
          )
          const snapshot = await compare(`/builds/${slug}/snapshots/numeric?version=1`, 'GET')
          assert.equal(
            snapshot.actualText.match(/"n":([^,}\]]+)/)![1]!,
            snapshot.expectedText.match(/"n":([^,}\]]+)/)![1]!,
            `raw snapshot numeric precision ${literal}`,
          )
          const states =
            await inspect`SELECT scope_key,state#>>'{}' AS encoded FROM reducer_snapshots WHERE scope_kind='build' AND scope_key IN (${slug.replace('SIDE', 'native')},${slug.replace('SIDE', 'oracle')}) AND reducer='numeric' ORDER BY scope_key`
          assert.equal(states.length, 2)
          assert.deepEqual(
            JSON.parse(states[0]!.encoded),
            JSON.parse(states[1]!.encoded),
            `snapshot detached JSON state ${literal}`,
          )
          const stateActual = (states[0]!.encoded as string).match(/"n":([^,}\]]+)/)![1]!
          const stateExpected = (states[1]!.encoded as string).match(/"n":([^,}\]]+)/)![1]!
          assert.equal(
            stateActual,
            stateExpected,
            `SQL snapshot encoded state precision ${literal}`,
          )

          // Typed number branches must retain nonfinite values until validation;
          // prematurely converting Infinity to null changes the exact Zod issues.
          await compare(
            `/builds/${slug}/lease/claim`,
            'POST',
            `{"holder":"numeric","ttlMs":${literal}}`,
          )
          await compare(
            `/builds/${slug}/snapshots/typed`,
            'PUT',
            `{"version":${literal},"cursor":0,"state":{}}`,
          )
          await compare(
            `/builds/${slug}/events/conditional`,
            'POST',
            `{"expectedSeq":${literal},"event":${JSON.stringify(sampleEventWrite())}}`,
          )
          await ts.ensureRepo(`numeric-native-${index}`)
          await ts.ensureRepo(`numeric-oracle-${index}`)
          const repoEvent = JSON.stringify(harvestStartedWrite()).replace(
            '"rev":0',
            `"rev":${literal}`,
          )
          const payload = await compare(`/repos/numeric-SIDE-${index}/events`, 'POST', repoEvent)
          assert.ok(
            payload.status === 201 || payload.status === 422,
            `producer validation reached for ${literal}`,
          )
        }
        // Internal serde marker spellings remain ordinary user-controlled JSON
        // object keys. Neither parser nor a JSONB/snapshot read may reinterpret
        // an actual object as its private numeric representation.
        await ts.createBuild({ slug: 'numeric-native-markers', repo: 'numeric-native-repo' })
        await ts.createBuild({ slug: 'numeric-oracle-markers', repo: 'numeric-oracle-repo' })
        for (const [index, object] of [
          '{"$serde_json::private::Number":"9007199254740993"}',
          '{"$serde_json::private::Number":"1e400"}',
          '{"$serde_json::private::Number":"not-a-number"}',
          '{"$serde_json::private::Number":"1","retained":true}',
          '{"retained":true,"$serde_json::private::Number":"1"}',
          '{"10":1,"2":2,"01":3,"4294967294":4,"4294967295":5,"0":6,"-0":7,"1e0":8,"00":9,"a":10}',
          '{"$serde_json::private::RawValue":"{\\"n\\":1}"}',
        ].entries()) {
          const metadata = `{"n":${object}}`
          assert.equal(
            (
              await compare(
                '/builds/numeric-SIDE-markers/artifacts',
                'POST',
                `{"kind":"marker-${index}","contentBase64":"YQ==","metadata":${metadata}}`,
              )
            ).status,
            201,
          )
          const artifact = await compare(
            `/builds/numeric-SIDE-markers/artifacts?kind=marker-${index}`,
            'GET',
          )
          assert.equal(artifact.status, 200)
          assert.equal(
            artifact.actualText,
            artifact.expectedText,
            'unknown object raw response retains JS property enumeration',
          )
          await compare(
            `/builds/numeric-SIDE-markers/snapshots/marker-${index}`,
            'PUT',
            `{"version":1,"cursor":0,"state":${metadata}}`,
          )
          const snapshot = await compare(
            `/builds/numeric-SIDE-markers/snapshots/marker-${index}?version=1`,
            'GET',
          )
          assert.equal(snapshot.status, 200)
          assert.equal(
            snapshot.actualText,
            snapshot.expectedText,
            'snapshot state raw response retains JS property enumeration',
          )
          const states =
            await inspect`SELECT state#>>'{}' AS encoded FROM reducer_snapshots WHERE scope_kind='build' AND scope_key IN ('numeric-native-markers','numeric-oracle-markers') AND reducer=${`marker-${index}`} ORDER BY scope_key`
          assert.equal(states.length, 2)
          assert.equal(
            states[0]!.encoded,
            states[1]!.encoded,
            'persisted snapshot JSON text retains JS numeric-key enumeration',
          )
        }
        checks.push(
          'private serde numeric/raw marker spellings remain ordinary unknown object keys through parse, JSONB metadata and snapshot reads',
        )
        checks.push(
          `${literals.length} raw literal variants: signed unsafe integers, binary64 rounding ties, exponent boundaries, subnormals, underflow, negative zero and signed overflow`,
        )
        checks.push(
          'artifact metadata, nested/array unknown values and public snapshot state round-trip with exact SQL JSONB/encoded numeric text',
        )
        checks.push(
          'typed lease/snapshot/CAS wire fields and repository producer payload compare exact TypeScript rejection messages',
        )
      } catch (error) {
        failure = error
      } finally {
        const cleanup = await Promise.allSettled([server?.close(), ts.close(), inspect.close()])
        const rejected = cleanup.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )
        if (rejected.length)
          failure = new AggregateError(
            [
              ...(failure === undefined ? [] : [failure]),
              ...rejected.map((result) => result.reason),
            ],
            'Numeric JSON proof cleanup failed',
          )
      }
      if (failure !== undefined) throw failure
    })
  })
  return { kind: 'raw-json-number-parity', fullBuildStoreContract: false, comparisons, checks }
}
