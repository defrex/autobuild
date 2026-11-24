import { describe, expect, test } from 'bun:test'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { parseConfig } from './load'
import { LiveConfig, type ConfigReloadPublisher } from './live'
import type { LocalOverrideRecord } from './local'

const base = `
capacity = 1

[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "pi"
model = "gpt-old"
`
const LOCAL = '/repo/.autobuild/local.toml'

const runtimes: RuntimeRegistry = {
  pi: {
    runner: new ScriptedAgentRunner({ script: () => defaultTurnResult() }),
    servesModels: ['gpt-'],
  },
}

function live(startup: string | { committed: string; local?: string } = base) {
  const published: Array<{ content: string; localOverrides?: LocalOverrideRecord }> = []
  const publish: ConfigReloadPublisher = async ({ content, localOverrides }) => {
    published.push({ content, ...(localOverrides ? { localOverrides } : {}) })
  }
  const config = new LiveConfig(
    'autobuild.toml',
    parseConfig(base),
    startup,
    runtimes,
    publish,
    [],
    undefined,
    { localSource: LOCAL },
  )
  return { config, published }
}

describe('LiveConfig with a local override layer', () => {
  test('adopts a local change and publishes which settings it took', async () => {
    const { config, published } = live()
    const outcome = await config.refresh({ committed: base, local: 'capacity = 4\n' })
    expect(outcome.kind).toBe('adopted')
    expect(config.current().revision).toBe(1)
    expect(config.current().config.capacity).toBe(4)
    expect(config.current().localOverrides).toEqual({ file: LOCAL, settings: ['capacity'] })
    expect(published).toEqual([
      { content: base, localOverrides: { file: LOCAL, settings: ['capacity'] } },
    ])
    expect(await config.refresh({ committed: base, local: 'capacity = 4\n' })).toEqual({
      kind: 'unchanged',
    })
  })

  test('rejects a committed-only local key once and keeps the previous snapshot', async () => {
    const { config } = live()
    const candidate = { committed: base, local: '[verify]\nsteps = []\n' }
    const first = await config.refresh(candidate)
    expect(first.kind).toBe('rejected')
    expect(first.kind === 'rejected' && first.error).toStartWith(
      `${LOCAL}: verify can only be set in autobuild.toml`,
    )
    expect(first.kind === 'rejected' && first.notify).toBe(true)
    const second = await config.refresh(candidate)
    expect(second.kind === 'rejected' && second.notify).toBe(false)
    expect(config.current().revision).toBe(0)
    expect(config.current().config.capacity).toBe(1)
  })

  test('removing the local file adopts the committed values with no record', async () => {
    const { config, published } = live({ committed: base, local: 'capacity = 4\n' })
    const outcome = await config.refresh(base)
    expect(outcome.kind).toBe('adopted')
    expect(config.current().localOverrides).toBeUndefined()
    expect(published).toEqual([{ content: base }])
  })

  test('a plain committed string compares exactly as before', async () => {
    const { config } = live()
    expect(await config.refresh(base)).toEqual({ kind: 'unchanged' })
    expect(await config.refresh({ committed: base })).toEqual({ kind: 'unchanged' })
    const outcome = await config.refresh(base.replace('capacity = 1', 'capacity = 2'))
    expect(outcome.kind).toBe('adopted')
    expect(config.current().localOverrides).toBeUndefined()
  })
})
