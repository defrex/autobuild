import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'
import {
  REPOSITORY_STATE_EVENT_TYPES,
  REPOSITORY_LATEST_EVENT_TYPES,
} from '../../../packages/core/src/store/repo-state-events'
import { sources, experiment, root } from './fixture-core'

const policy = {
  sources: sources(),
  durable: [...REPOSITORY_STATE_EVENT_TYPES],
  latest: [...REPOSITORY_LATEST_EVENT_TYPES],
}
const path = resolve(experiment, 'fixtures/protocol-event-reads.json')
if (process.argv.includes('--write')) {
  const child = Bun.spawnSync(
    [resolve(root, 'node_modules/.bin/biome'), 'format', '--stdin-file-path', path],
    { stdin: Buffer.from(JSON.stringify(policy)), stdout: 'pipe', stderr: 'pipe' },
  )
  if (child.exitCode !== 0) throw new Error('Cannot format protocol event read policy')
  await Bun.write(path, child.stdout)
} else if (!isDeepStrictEqual(await Bun.file(path).json(), policy)) {
  throw new Error('Stale protocol event read policy; run bun tools/protocol-event-reads.ts --write')
}
console.log('Protocol repository bounded-read policy matches current core catalog')
