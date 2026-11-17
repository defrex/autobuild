import { describe, expect, test } from 'bun:test'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import { assertHooksRunnable } from '../cli/dispatch'
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
      '[hooks.notify] has no target — set command',
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
    expect(() => assertHooksRunnable(config, {})).not.toThrow()
    expect(() => assertHooksRunnable(config, { localCommands: false })).toThrow(
      'autobuild.toml: [hooks.notify] is a command hook, which needs a dispatcher that can run local commands',
    )
    expect(() => assertHooksRunnable(parseConfig(base), { localCommands: false })).not.toThrow()
    const live = new LiveConfig(
      'autobuild.toml',
      parseConfig(base),
      base,
      runtimes,
      async () => {},
      [],
      (next) => assertHooksRunnable(next, { localCommands: false }),
    )
    const outcome = await live.refresh(`${base}\n[hooks.notify]\ncommand = "true"\n`)
    expect(outcome.kind === 'rejected' && outcome.error).toContain('[hooks.notify]')
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
