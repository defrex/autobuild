import { describe, expect, test } from 'bun:test'
import { ConfigError, parseConfig } from './load'
import { BUILD_OWNED_CONFIG_PATHS, RESTART_REQUIRED_CONFIG_PATHS } from './live'
import {
  LOCAL_OVERRIDE_CLASSIFICATION,
  LOCAL_OVERRIDE_KEYS,
  localOverrideSettings,
  mergeConfigTables,
  parseLayeredConfig,
} from './local'
import { configRootSchema } from './schema'

const committed = `
capacity = 2

[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "pi"
model = "gpt-old"
args = ["--a", "--b"]

[roles.review]
model = "gpt-review"

[hooks.notify]
command = "./notify.sh"

[verify]
steps = ["unit"]

[verify.unit]
kind = "check"
command = "test"

[commands]
test = "bun test"
`
const LOCAL = '/repo/.autobuild/local.toml'

function layered(local?: string) {
  return parseLayeredConfig({
    committed: { text: committed, source: 'autobuild.toml' },
    ...(local === undefined ? {} : { local: { text: local, source: LOCAL } }),
  })
}

function failure(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as Error).message
  }
  throw new Error('expected a config error')
}

describe('local override classification', () => {
  test('every raw root key is classified', () => {
    expect(Object.keys(LOCAL_OVERRIDE_CLASSIFICATION).sort()).toEqual(
      Object.keys(configRootSchema.shape).sort(),
    )
  })

  test('the allowlist is exactly the personal and machine-local sections', () => {
    const allowlist: string[] = [...LOCAL_OVERRIDE_KEYS].sort()
    expect(allowlist).toEqual(
      ['accounts', 'capacity', 'hooks', 'roles', 'ticketScanIntervalSeconds', 'upgrade'].sort(),
    )
  })

  test('build-owned and restart-required sections are committed-only', () => {
    for (const path of [...BUILD_OWNED_CONFIG_PATHS, ...RESTART_REQUIRED_CONFIG_PATHS]) {
      const root = path.split('.')[0] as keyof typeof LOCAL_OVERRIDE_CLASSIFICATION
      expect(LOCAL_OVERRIDE_CLASSIFICATION[root]).toBe('committed')
    }
  })
})

describe('parseLayeredConfig', () => {
  test('without a local file it is parseConfig of the committed text', () => {
    const result = layered()
    expect(result.config).toEqual(parseConfig(committed))
    expect(result.localOverrides).toBeUndefined()
  })

  test('a local scalar wins', () => {
    const result = layered('capacity = 4\n')
    expect(result.config.capacity).toBe(4)
    expect(result.localOverrides).toEqual({ file: LOCAL, settings: ['capacity'] })
  })

  test('tables merge key by key and keep the committed keys they do not set', () => {
    const result = layered('[roles.default]\nmodel = "gpt-new"\n')
    expect(result.config.roles.default).toEqual({
      runtime: 'pi',
      model: 'gpt-new',
      args: ['--a', '--b'],
    })
    expect(result.config.roles.review).toEqual({ model: 'gpt-review' })
    expect(result.localOverrides?.settings).toEqual(['roles.default.model'])
  })

  test('a local hook joins the committed hooks', () => {
    const result = layered('[hooks.mine]\ncommand = "./mine.sh"\n')
    expect(Object.keys(result.config.hooks).sort()).toEqual(['mine', 'notify'])
    expect(result.localOverrides?.settings).toEqual(['hooks.mine.command'])
  })

  test('upgrade and scan cadence are overridable', () => {
    const result = layered('ticketScanIntervalSeconds = 5\n[upgrade]\nautomatic = false\n')
    expect(result.config.upgrade.automatic).toBe(false)
    expect(result.config.ticketScanIntervalSeconds).toBe(5)
  })

  test('a local array replaces the committed array whole', () => {
    const result = layered('[roles.default]\nargs = ["--c"]\n')
    expect(result.config.roles.default?.args).toEqual(['--c'])
    expect(result.localOverrides?.settings).toEqual(['roles.default.args'])
  })

  test('committed-only and unknown keys are rejected together, naming the local file', () => {
    for (const key of ['verify', 'tickets', 'store', 'merge', 'landing', 'workspace']) {
      const message = failure(() =>
        layered(`[${key === 'merge' || key === 'landing' ? `[${key}]` : key}]\n`),
      )
      expect(message.startsWith(`${LOCAL}: ${key} can only be set in autobuild.toml`)).toBe(true)
      expect(message).toContain('local overrides accept capacity, ticketScanIntervalSeconds')
    }
    const message = failure(() => layered('baseBranch = "dev"\nbogus = 1\ncapacity = 3\n'))
    expect(message.split('\n')).toEqual([
      `${LOCAL}: baseBranch can only be set in autobuild.toml — local overrides accept capacity, ticketScanIntervalSeconds, upgrade, hooks, roles, accounts`,
      `${LOCAL}: "bogus" is not a configuration setting — local overrides accept capacity, ticketScanIntervalSeconds, upgrade, hooks, roles, accounts`,
    ])
  })

  test('an invalid local value gets the autobuild.toml message, naming the local file', () => {
    const cases: Array<[string, string]> = [
      ['capacity = 0\n', committed.replace('capacity = 2\n', 'capacity = 0\n')],
      [
        '[roles.default]\nbogus = 1\n',
        committed.replace('[roles.default]\n', '[roles.default]\nbogus = 1\n'),
      ],
    ]
    for (const [fragment, inlined] of cases) {
      const local = failure(() => layered(fragment))
      const inline = failure(() => parseConfig(inlined, 'autobuild.toml'))
      expect(local.startsWith(`${LOCAL}: invalid config\n`)).toBe(true)
      expect(local.replace(LOCAL, 'autobuild.toml')).toBe(inline)
    }
  })

  test('a local syntax error names the local file', () => {
    expect(failure(() => layered('capacity = = 1\n'))).toStartWith(`${LOCAL}: TOML syntax error:`)
  })

  test('an invalid committed file is reported against autobuild.toml', () => {
    const message = failure(() =>
      parseLayeredConfig({
        committed: { text: 'capacity = 0\n', source: 'autobuild.toml' },
        local: { text: 'capacity = 3\n', source: LOCAL },
      }),
    )
    expect(message).toStartWith('autobuild.toml: ')
    expect(message).not.toContain(LOCAL)
  })

  test('a local open-map entry named __proto__ survives as an own key', () => {
    const result = layered('[roles.__proto__]\nmodel = "gpt-proto"\n')
    expect(Object.hasOwn(result.config.roles, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(result.config.roles, '__proto__')?.value).toEqual({
      model: 'gpt-proto',
    })
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(result.localOverrides?.settings).toEqual(['roles.__proto__.model'])
  })
})

describe('mergeConfigTables', () => {
  test('never mutates either input', () => {
    const base = { roles: { default: { model: 'a', runtime: 'pi' } } }
    const local = { roles: { default: { model: 'b' } } }
    const snapshot = JSON.stringify([base, local])
    expect(mergeConfigTables(base, local)).toEqual({
      roles: { default: { model: 'b', runtime: 'pi' } },
    })
    expect(JSON.stringify([base, local])).toBe(snapshot)
  })

  test('a table over a scalar replaces it, leaving the type problem to validation', () => {
    expect(mergeConfigTables({ capacity: 2 }, { capacity: { x: 1 } })).toEqual({
      capacity: { x: 1 },
    })
  })
})

describe('localOverrideSettings', () => {
  test('lists sorted dotted leaves, quoting keys that need it', () => {
    expect(
      localOverrideSettings({
        roles: { default: { model: 'x', args: ['a'] } },
        capacity: 3,
        hooks: { 'a.b': { url: 'u' }, empty: {} },
      }),
    ).toEqual([
      'capacity',
      'hooks."a.b".url',
      'hooks.empty',
      'roles.default.args',
      'roles.default.model',
    ])
  })
})
