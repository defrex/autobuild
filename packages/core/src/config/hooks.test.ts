import { describe, expect, test } from 'bun:test'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { assertHooksDeliverable } from '../cli/dispatch'
import { ConfigError, parseConfig } from './load'
import { CONFIG_RELOAD_CLASSIFICATION, LiveConfig } from './live'
import { effectiveBuildConfigContent } from '../processes/build-execution-state'

const base = `
[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "pi"
model = "gpt-old"
`

const runtimes: RuntimeRegistry = {
  pi: {
    runner: new ScriptedAgentRunner({ script: () => defaultTurnResult() }),
    servesModels: ['gpt-'],
  },
}

function rejection(text: string): string {
  try {
    parseConfig(`${base}${text}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as Error).message
  }
  throw new Error('expected a config error')
}

describe('[hooks] configuration', () => {
  test('parses named hooks with the 30 second default timeout', () => {
    const config = parseConfig(`${base}
[hooks.notify]
command = "./notify.sh"

[hooks.audit]
command = "cat >> audit.log"
events = ["escalation.*", "hook.*"]
timeoutSeconds = 5
`)
    expect(config.hooks).toEqual({
      notify: { command: './notify.sh', timeoutSeconds: 30 },
      audit: { command: 'cat >> audit.log', events: ['escalation.*', 'hook.*'], timeoutSeconds: 5 },
    })
  })

  test('an absent table is no hooks', () => {
    expect(parseConfig(base).hooks).toEqual({})
  })

  test('accepts repository globs and dispatcher.lost, as an unscoped ab watch does', () => {
    const config = parseConfig(`${base}
[hooks.ops]
command = "true"
events = ["dispatcher.*", "dispatcher.lost", "ticket.handed-back"]
`)
    expect(config.hooks.ops?.events).toHaveLength(3)
  })

  test('rejects each invalid hook with an error naming it', () => {
    expect(rejection('[hooks.notify]\nevents = ["escalation.raised"]\n')).toContain(
      '[hooks.notify] has no target — set command or url',
    )
    expect(rejection('[hooks.notify]\ncommand = "true"\nevents = ["nope.*"]\n')).toContain(
      '[hooks.notify].events: "nope.*" matches no known event type in the build or repository catalogs',
    )
    expect(rejection('[hooks.notify]\ncommand = "true"\nevents = []\n')).toContain(
      'hooks.notify.events: list at least one event glob',
    )
    expect(rejection('[hooks."bad name"]\ncommand = "true"\n')).toContain(
      '[hooks.bad name] name must contain only ASCII letters',
    )
    expect(rejection('[hooks.".."]\ncommand = "true"\n')).toContain('[hooks...] name must')
    expect(
      rejection('[hooks.notify]\ncommand = "true"\n\n[hooks.notify]\ncommand = "false"\n'),
    ).toContain('duplicate hook name "notify" — declare each [hooks.<name>] table once')
    expect(rejection('[hooks.notify]\ncommand = "true"\nretries = 3\n')).toContain('hooks.notify')
  })

  test('other syntax errors keep the generic message', () => {
    expect(rejection('[roles.default]\nruntime = "pi"\n')).toContain('TOML syntax error')
  })

  test('hooks are classified hot', () => {
    expect(CONFIG_RELOAD_CLASSIFICATION.hooks).toBe('hot')
  })

  test('a reload adding an invalid hook is rejected naming it and keeps the running snapshot', async () => {
    const live = new LiveConfig('autobuild.toml', parseConfig(base), base, runtimes, async () => {})
    const outcome = await live.refresh(`${base}\n[hooks.notify]\nevents = ["nope"]\n`)
    expect(outcome.kind).toBe('rejected')
    expect(outcome.kind === 'rejected' && outcome.error).toContain('[hooks.notify]')
    expect(live.current().config.hooks).toEqual({})
    const adopted = await live.refresh(`${base}\n[hooks.notify]\ncommand = "true"\n`)
    expect(adopted.kind).toBe('adopted')
    expect(live.current().config.hooks.notify?.command).toBe('true')
  })

  test('a command hook is rejected on a dispatcher that cannot run local commands', async () => {
    const config = parseConfig(`${base}\n[hooks.notify]\ncommand = "true"\n`)
    expect(() => assertHooksDeliverable(config, { env: {} })).not.toThrow()
    expect(() => assertHooksDeliverable(config, { localCommands: false, env: {} })).toThrow(
      'autobuild.toml: [hooks.notify] is a command hook, which needs a dispatcher that can run local commands; the hosted dispatcher cannot — use a url hook',
    )
    expect(() =>
      assertHooksDeliverable(parseConfig(base), { localCommands: false, env: {} }),
    ).not.toThrow()
    const live = new LiveConfig(
      'autobuild.toml',
      parseConfig(base),
      base,
      runtimes,
      async () => {},
      [],
      (next) => assertHooksDeliverable(next, { localCommands: false, env: {} }),
    )
    const outcome = await live.refresh(`${base}\n[hooks.notify]\ncommand = "true"\n`)
    expect(outcome.kind === 'rejected' && outcome.error).toContain('[hooks.notify]')
  })

  test('parses url hooks with their signing-secret variable', () => {
    const config = parseConfig(`${base}
[hooks.relay]
url = "https://hooks.example/autobuild?team=ops"
secretEnv = "RELAY_SECRET"
timeoutSeconds = 10
`)
    expect(config.hooks.relay).toEqual({
      url: 'https://hooks.example/autobuild?team=ops',
      secretEnv: 'RELAY_SECRET',
      timeoutSeconds: 10,
    })
  })

  test('url hooks accept https and loopback http only', () => {
    const url = (value: string): string =>
      `[hooks.relay]\nurl = ${JSON.stringify(value)}\nsecretEnv = "S"\n`
    for (const accepted of [
      'http://localhost:8080/x',
      'http://127.0.0.1/x',
      'http://127.1.2.3/',
      'http://[::1]/',
      'https://hooks.example/x?a=1',
    ])
      expect(parseConfig(`${base}${url(accepted)}`).hooks.relay?.url).toBe(accepted)
    for (const rejected of ['http://example.com/x', 'ftp://hooks.example/x', 'http://127.example/'])
      expect(rejection(url(rejected))).toContain(
        'hooks.relay.url: hook url must be https (http is allowed only to loopback',
      )
    for (const rejected of ['https://user:pass@hooks.example/x', 'https://hooks.example/x#frag'])
      expect(rejection(url(rejected))).toContain(
        'hooks.relay.url: hook url must not contain credentials or a fragment',
      )
    for (const rejected of ['not a url', ' https://hooks.example/x'])
      expect(rejection(url(rejected))).toContain(
        'hooks.relay.url: hook url must be an absolute URL',
      )
  })

  test('rejects each invalid url hook target with an error naming it', () => {
    expect(
      rejection(
        '[hooks.relay]\ncommand = "true"\nurl = "https://hooks.example/x"\nsecretEnv = "S"\n',
      ),
    ).toContain('[hooks.relay] sets both command and url — set exactly one')
    expect(rejection('[hooks.relay]\nurl = "https://hooks.example/x"\n')).toContain(
      '[hooks.relay] url hooks require secretEnv naming the signing-secret environment variable',
    )
    expect(rejection('[hooks.relay]\ncommand = "true"\nsecretEnv = "S"\n')).toContain(
      '[hooks.relay].secretEnv applies only to url hooks',
    )
    expect(
      rejection('[hooks.relay]\nurl = "https://hooks.example/x"\nsecretEnv = "not-a-name"\n'),
    ).toContain('hooks.relay.secretEnv')
  })

  test('a url hook needs its signing secret set in the dispatcher environment', async () => {
    const config = parseConfig(`${base}
[hooks.audit]
url = "https://audit.example/x"
secretEnv = "AUDIT_SECRET"

[hooks.relay]
url = "https://hooks.example/x"
secretEnv = "RELAY_SECRET"
`)
    const sentinel = 'sentinel-secret-value'
    for (const env of [
      { AUDIT_SECRET: sentinel },
      { AUDIT_SECRET: sentinel, RELAY_SECRET: '' },
      { AUDIT_SECRET: sentinel, RELAY_SECRET: '  ' },
    ]) {
      let message = ''
      try {
        assertHooksDeliverable(config, { env })
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError)
        message = (error as Error).message
      }
      expect(message).toBe(
        'autobuild.toml: [hooks.relay].secretEnv names RELAY_SECRET, which is unset or empty in the dispatcher environment',
      )
      expect(message).not.toContain(sentinel)
    }
    const env = { AUDIT_SECRET: sentinel, RELAY_SECRET: 's' }
    expect(() => assertHooksDeliverable(config, { env })).not.toThrow()
    // The hosted dispatcher delivers url hooks.
    expect(() => assertHooksDeliverable(config, { env, localCommands: false })).not.toThrow()
    const live = new LiveConfig(
      'autobuild.toml',
      parseConfig(base),
      base,
      runtimes,
      async () => {},
      [],
      (next) => assertHooksDeliverable(next, { localCommands: false, env: { RELAY_SECRET: '' } }),
    )
    const outcome = await live.refresh(
      `${base}\n[hooks.relay]\nurl = "https://hooks.example/x"\nsecretEnv = "RELAY_SECRET"\n`,
    )
    expect(outcome.kind === 'rejected' && outcome.error).toContain(
      '[hooks.relay].secretEnv names RELAY_SECRET',
    )
    expect(live.current().config.hooks).toEqual({})
  })

  test('effective config artifacts omit an empty hooks table', () => {
    expect(JSON.parse(effectiveBuildConfigContent(parseConfig(base)))).not.toHaveProperty('hooks')
    expect(
      JSON.parse(
        effectiveBuildConfigContent(parseConfig(`${base}\n[hooks.notify]\ncommand = "true"\n`)),
      ).hooks,
    ).toEqual({ notify: { command: 'true', timeoutSeconds: 30 } })
  })
})
