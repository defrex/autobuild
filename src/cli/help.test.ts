import { describe, expect, test } from 'bun:test'
import { HELP_CATALOG, recognizeHelpRequest, renderCommandHelp, renderTopLevelHelp } from './help'
import { isSessionlessInvocation, runCli } from './main'

const COMMANDS = [
  'help',
  'init',
  'upgrade',
  'dispatch',
  'ticket',
  'builds',
  'build',
  'pause',
  'resume',
  'answer',
  'abort',
  'auto-merge',
  'models',
  'plugin',
  'context',
  'artifact',
  'observe',
  'server',
  'done',
  'verdict',
  'escalate',
  'harvest',
] as const

function deps(): {
  workspacePath: string
  stdout: (line: string) => void
  stderr: (line: string) => void
  out: string[]
  err: string[]
} {
  const out: string[] = []
  const err: string[] = []
  return {
    workspacePath: '/no/help/dependencies',
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    out,
    err,
  }
}

describe('layered CLI help catalog', () => {
  test('contains every routed command family once in audience order', () => {
    expect(HELP_CATALOG.map((entry) => entry.name)).toEqual([...COMMANDS])
    expect(new Set(HELP_CATALOG.map((entry) => entry.name)).size).toBe(HELP_CATALOG.length)
    const firstAi = HELP_CATALOG.findIndex((entry) => entry.audience === 'ai')
    expect(firstAi).toBeGreaterThan(0)
    expect(HELP_CATALOG.slice(0, firstAi).every((entry) => entry.audience === 'human')).toBe(true)
    expect(HELP_CATALOG.slice(firstAi).every((entry) => entry.audience === 'ai')).toBe(true)
  })

  test('overview orients before exactly two audience sections and keeps entries one-line', () => {
    const help = renderTopLevelHelp()
    const lines = help.split('\n')
    const human = lines.indexOf('Human-first commands:')
    const ai = lines.indexOf('AI-first commands:')

    expect(help).toContain('Primary human workflow:')
    expect(help).toContain('`ab init`')
    expect(help).toContain('`ab dispatch`')
    expect(help).toContain('ab help <command>')
    expect(help).toContain('ab <command> --help')
    expect(human).toBeGreaterThan(lines.indexOf('Primary human workflow:'))
    expect(ai).toBeGreaterThan(human)
    expect(lines.filter((line) => line.endsWith('-first commands:'))).toEqual([
      'Human-first commands:',
      'AI-first commands:',
    ])

    const entries = lines.filter((line) => /^ {2}ab [a-z-]+\s{2,}\S/.test(line))
    expect(entries).toHaveLength(COMMANDS.length)
    expect(entries.map((line) => /^ {2}ab ([a-z-]+)/.exec(line)?.[1])).toEqual([...COMMANDS])
    for (const line of entries) {
      expect(line).not.toContain('[')
      expect(line).not.toContain('<')
      expect(line.split('\n')).toHaveLength(1)
    }
  })

  test('help, --help, and -h are byte-identical while bare ab uses stderr', async () => {
    const outputs: string[] = []
    for (const alias of ['help', '--help', '-h']) {
      const d = deps()
      expect(await runCli([alias], d)).toBe(0)
      expect(d.err).toEqual([])
      expect(d.out).toHaveLength(1)
      outputs.push(d.out[0]!)
    }
    expect(new Set(outputs)).toEqual(new Set([renderTopLevelHelp()]))

    const bare = deps()
    expect(await runCli([], bare)).toBe(1)
    expect(bare.out).toEqual([])
    expect(bare.err).toEqual([renderTopLevelHelp()])
  })

  test('both detailed forms are byte-identical for every family without session deps', async () => {
    for (const command of COMMANDS) {
      const canonical = deps()
      const flag = deps()
      expect(await runCli(['help', command], canonical)).toBe(0)
      expect(await runCli([command, '--help'], flag)).toBe(0)
      expect(canonical.err).toEqual([])
      expect(flag.err).toEqual([])
      expect(canonical.out).toEqual([renderCommandHelp(command)])
      expect(flag.out).toEqual(canonical.out)
    }
  })

  test('detailed pages retain nested forms, flags, and behavioral notes from flat help', () => {
    const expected: Record<(typeof COMMANDS)[number], string[]> = {
      help: ['ab help <command>', 'requires no', 'AB_*'],
      init: ['ab init [target] [--force]', 'never overwrites an', 'autobuild.toml'],
      upgrade: ['ab upgrade [target]', 'Three-way merge', 'outside sessions'],
      dispatch: [
        '--intake | --no-intake',
        '--auto-merge | --no-auto-merge',
        'omission',
        'fresh repo: intake on, auto-merge off',
        'TTY controls:',
        'Up/Down',
        'Enter submits',
        '--plain',
      ],
      ticket: [
        'ticket create',
        'ticket update',
        'ticket block',
        'ticket unblock',
        'ticket list',
        'ticket show',
        'ticket move',
        'same ready criteria as dispatch',
        'first id is always the ticket being changed',
      ],
      builds: ['--queued', '--all', '--json', '--store', 'running, paused, blocked'],
      build: ['build status', '--events <n>', 'escalations', 'lease'],
      pause: ['pause <slug>', '--store', 'sessionless'],
      resume: ['resume <slug>', 'does not answer open', 'ab answer'],
      answer: ['answer <slug>', 'bare retry', 'resume is requested last'],
      abort: ['abort <slug>', '--store', 'sessionless'],
      'auto-merge': ['auto-merge <slug> <on|off>', 'native squash auto-merge'],
      models: ['models [query] [--available]', 'provider-qualified', 'outside sessions'],
      plugin: ['plugin list', 'plugin doctor', 'plugin test', 'AB_RUN_LIVE_PORT_CONTRACTS=1'],
      context: ['context [--json]', 'Hydrate .ab/', 'inside a build session'],
      artifact: [
        'artifact put',
        '--attach',
        'artifact get',
        'artifact download',
        'exact artifact bytes',
        'sessionless',
      ],
      observe: ['followup|refactor|latent-bug', '--files', '--refs', 'not a terminal'],
      server: ['server start', 'server logs [n]', 'implement and verify', 'kernel owns teardown'],
      done: ['done [--notes <file>]', 'terminal command', 'exactly one terminal'],
      verdict: [
        'approve|revise|escalate|pass|fail|skip',
        '--findings',
        '--report',
        'phase-dependent',
      ],
      escalate: ['escalate <question>', '--refs', 'Park the build', 'terminal command'],
      harvest: [
        'harvest status',
        'harvest context',
        'harvest submit',
        'harvest verdict',
        'sessionless',
        'harvest session',
      ],
    }

    for (const command of COMMANDS) {
      const detail = renderCommandHelp(command)
      for (const fact of expected[command]) expect(detail).toContain(fact)
    }
  })

  test('unknown and malformed help requests fail with targeted feedback', async () => {
    const unknown = deps()
    expect(await runCli(['help', 'frobnicate'], unknown)).toBe(1)
    expect(unknown.out).toEqual([])
    expect(unknown.err.join('\n')).toContain('unknown help command "frobnicate"')

    const malformed = deps()
    expect(await runCli(['help', 'context', 'extra'], malformed)).toBe(1)
    expect(malformed.err.join('\n')).toContain('usage: ab help [command]')
  })

  test('the recognizer and binary classifier lift exact help forms only', () => {
    expect(recognizeHelpRequest(['help'])).toEqual({ kind: 'overview' })
    expect(recognizeHelpRequest(['help', 'context'])).toEqual({
      kind: 'command',
      command: 'context',
    })
    expect(recognizeHelpRequest(['context', '--help'])).toEqual({
      kind: 'command',
      command: 'context',
    })
    expect(recognizeHelpRequest(['help', '--help'])).toEqual({
      kind: 'command',
      command: 'help',
    })
    expect(recognizeHelpRequest(['context', '--help', 'extra'])).toBeUndefined()

    for (const command of [
      'context',
      'artifact',
      'observe',
      'server',
      'done',
      'verdict',
      'escalate',
      'harvest',
    ]) {
      expect(isSessionlessInvocation([command, '--help'])).toBe(true)
    }
    expect(isSessionlessInvocation(['context'])).toBe(false)
    expect(isSessionlessInvocation(['context', '--help', 'extra'])).toBe(false)
    expect(isSessionlessInvocation(['artifact', 'put'])).toBe(false)
    expect(isSessionlessInvocation(['harvest', 'context'])).toBe(false)
  })
})
