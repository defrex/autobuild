import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkoutRoot, suiteCommands } from './test-temp-leaks'

/**
 * The shared runner isolates every suite child's git config through env
 * variables. A subprocess spawned with a hand-picked env that forwards the
 * real HOME drops them and rediscovers the developer's global and XDG git
 * config, so every such boundary must spread `inheritedGitConfigIsolation()`.
 */
const FORWARDS_REAL_HOME = new RegExp(['HOME:', 'process\\.env\\.HOME\\b'].join('\\s*'))

test('every integration test forwarding the real HOME also forwards git config isolation', async () => {
  const [command = []] = await suiteCommands('integration', [], { env: {}, report: () => {} })
  const files = command.slice(2)
  expect(files.length).toBeGreaterThan(0)
  const offending: string[] = []
  for (const file of files) {
    const source = await readFile(join(checkoutRoot, file), 'utf8')
    if (FORWARDS_REAL_HOME.test(source) && !source.includes('inheritedGitConfigIsolation('))
      offending.push(file)
  }
  expect(offending).toEqual([])
})
