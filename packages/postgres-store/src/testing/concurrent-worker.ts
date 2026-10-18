import { MemoryBlobStore, sampleEventWrite } from '@defrex/autobuild/plugin-sdk'
import { SQL } from 'bun'
import { PostgresBuildStore } from '../store'

async function main(): Promise<void> {
  const [url, mode, resource, countText] = process.argv.slice(2)
  if (!url || !mode || !resource) throw new Error('missing worker arguments')
  const count = Number(countText ?? '1')
  // The parent already migrated the schema. Each sequential worker needs only
  // one connection, even while several independent processes race writes.
  const store = new PostgresBuildStore(new SQL(url, { max: 1 }), {
    blobs: new MemoryBlobStore(),
  })
  try {
    if (mode === 'build') {
      for (let index = 0; index < count; index++) {
        await store.append(resource, sampleEventWrite(`${process.pid}-${index}`))
      }
    } else if (mode === 'repo') {
      for (let index = 0; index < count; index++) {
        await store.appendRepo(resource, {
          actor: { kind: 'human', user: `worker-${process.pid}` },
          type: 'dispatcher.pause-set',
          payload: { enabled: index % 2 === 0 },
        })
      }
    } else if (mode === 'conditional') {
      const result = await store.appendIfCurrent(
        resource,
        count,
        sampleEventWrite(String(process.pid)),
      )
      console.log(result ? 'winner' : 'stale')
    } else {
      throw new Error(`unknown worker mode ${mode}`)
    }
  } finally {
    await store.close()
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
