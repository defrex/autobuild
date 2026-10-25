/** Explicit full unchanged shared suite. Importing this file during the root
 * database-free unit run registers nothing and performs no database work. */
import { beforeAll, afterAll } from 'bun:test'
import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import {
  describeBuildStoreContract,
  type BuildStoreFactory,
} from '../../../packages/core/src/store/contract'
import { RemoteBuildStore } from '../../../packages/core/src/store/remote/client'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { startProtocolServer } from './protocol-server-harness'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

if (process.env.PROA_RUN_FULL_CONTRACT === '1') {
  const executable = process.env.PROA_PROTOCOL_EXECUTABLE
  if (!executable) throw new Error('Full Rust contract requires its compiled native executable')
  const serviceReady = deferred<{ admin: string; env: Record<string, string | undefined> }>()
  const serviceRelease = deferred<void>()
  let serviceLifetime: Promise<unknown> | undefined
  let factoryCalls = 0,
    cleanups = 0
  const active = new Set<() => Promise<void>>()
  beforeAll(async () => {
    serviceLifetime = withDataServices(async (admin, env) => {
      serviceReady.resolve({ admin, env })
      await serviceRelease.promise
    })
    void serviceLifetime.catch(serviceReady.reject)
    await serviceReady.promise
  }, 60000)
  afterAll(async () => {
    let failure: unknown
    for (const close of [...active])
      await close().catch((error) => {
        failure ??= error
      })
    serviceRelease.resolve()
    await serviceLifetime?.catch((error) => {
      failure ??= error
    })
    const evidence = process.env.PROA_PROTOCOL_CONTRACT_FACTORY_REPORT
    if (evidence)
      await Bun.write(
        evidence,
        `${JSON.stringify({ factoryCalls, cleanups, openFactories: active.size })}\n`,
      )
    assert.ok(factoryCalls > 0, 'The unchanged shared suite must invoke its real Rust factory')
    assert.equal(cleanups, factoryCalls, 'Every isolated contract factory must be torn down')
    if (failure) throw failure
  }, 60000)
  const factory: BuildStoreFactory = async (options) => {
    const { admin, env } = await serviceReady.promise
    const ready = deferred<Awaited<ReturnType<BuildStoreFactory>>>()
    const release = deferred<void>()
    let closed: Promise<void> | undefined
    factoryCalls++
    const lifetime = withProtocolDatabase(
      admin,
      { ...env, AB_BLOB_PREFIX: `protocol-contract/${crypto.randomUUID()}` },
      async (isolated) => {
        const server = await startProtocolServer({
          executable,
          env: isolated,
          clock: options?.clock ?? (() => new Date()),
          retention: options?.retention,
        })
        const close = () => {
          closed ??= (async () => {
            release.resolve()
            await lifetime
            active.delete(close)
            cleanups++
          })()
          return closed
        }
        active.add(close)
        ready.resolve({
          store: new RemoteBuildStore({ url: server.url, fetchFn: server.fetch }),
          cleanup: close,
        })
        try {
          await release.promise
        } finally {
          await server.close()
        }
      },
    )
    void lifetime.catch(ready.reject)
    return ready.promise
  }
  describeBuildStoreContract('Proa Rust HTTP', factory)
}

export const protocolContractTestPath = resolve(
  import.meta.dir,
  'protocol-contract.integration.test.ts',
)
