import { describe, expect, test } from 'bun:test'
import { HELP_CATALOG, recognizeHelpRequest, renderCommandHelp, renderTopLevelHelp } from './help'
import { isSessionlessInvocation, runCli } from './main'

const COMMANDS = [
  'help',
  'init',
  'upgrade',
  'dispatch',
  'ticket',
  'repository',
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

  test('update help resolves to the canonical upgrade page without adding an overview row', async () => {
    const outputs: string[] = []
    for (const argv of [
      ['help', 'upgrade'],
      ['upgrade', '--help'],
      ['help', 'update'],
      ['update', '--help'],
    ]) {
      const d = deps()
      expect(await runCli(argv, d)).toBe(0)
      expect(d.err).toEqual([])
      expect(d.out).toHaveLength(1)
      outputs.push(d.out[0]!)
    }

    expect(new Set(outputs)).toEqual(new Set([renderCommandHelp('upgrade')]))
    expect(renderCommandHelp('update')).toBe(renderCommandHelp('upgrade'))
    expect(outputs[0]).toContain('`ab update` is an accepted alias')
    expect(HELP_CATALOG.filter((entry) => entry.name === 'upgrade')).toHaveLength(1)
    expect(HELP_CATALOG.some((entry) => entry.name === 'update')).toBe(false)
    expect(renderTopLevelHelp()).not.toMatch(/^ {2}ab update\s/m)
  })

  test('detailed pages retain nested forms, flags, and behavioral notes from flat help', () => {
    const expected: Record<(typeof COMMANDS)[number], string[]> = {
      help: ['ab help <command>', 'requires no', 'AB_*'],
      init: [
        'ab init [target] [--force]',
        'stack-neutral',
        'fixed product',
        'setup agent',
        'exit status',
        'never overwrites autobuild.toml',
      ],
      upgrade: [
        'ab upgrade [target]',
        '`ab update` is an accepted alias',
        '--no-self-update',
        '--version <semver>',
        '--no-commit',
        'latest GitHub Release',
        'package.json',
        'bun.lock',
        'Three-way merge',
        'Unrelated staged',
        'missing its pre-update baseline',
        'pre-attempt index',
        'merge-derived exit status',
        'outside sessions',
      ],
      dispatch: [
        '--intake | --no-intake',
        '--auto-merge | --no-auto-merge',
        'omission',
        'fresh repo: intake on, auto-merge off',
        'TTY controls:',
        'Up/Down',
        'h         Toggle harvesting when the global row is selected.',
        'i         Toggle intake when the global row is selected.',
        'm         Toggle the claim-time default on the global row',
        'p         On the global row, pause every pausable build and turn intake',
        'On a build, pause or cancel a pending pause; on Harvest,',
        'r         On the global row, resume every paused build and turn intake',
        'On a build, resume a paused or blocked build.',
        'ab pause --all and ab resume --all are the sessionless equivalents',
        'Enter submits',
        '--plain',
      ],
      ticket: [
        'ticket create',
        '--state <state>',
        'overrides [tickets].createState',
        'passed through unchanged and validated by the source',
        'ticket update',
        'ticket block',
        'ticket unblock',
        'ticket list',
        'ticket show',
        'ticket move',
        'same ready criteria as dispatch',
        'first id is always the ticket being changed',
      ],
      repository: [
        'repository status [--json] [--store <ref>]',
        'ticket-intake setting',
        'repository-wide pause',
        'auto-merge default',
        'intake on, repository pause off, and auto-merge default off',
        '--store overrides AB_STORE',
        'starts no dispatcher',
        'writes no state',
      ],
      builds: [
        '--queued',
        '--all',
        '--json',
        '--store',
        'running, paused, blocked',
        'requires no session identity',
        'repository-wide list is denied',
        'malformed or partial identity is rejected',
      ],
      build: [
        'build status',
        '--events <n>',
        'escalations',
        'lease',
        'requires no session identity',
        'permits only the ambient build',
      ],
      pause: [
        'pause <slug>',
        '--store',
        'sessionless',
        'ab pause --all [--store <ref>] [--json]',
        'durably holds every queued build',
        'turns ticket intake off',
        'no dispatcher tick gives a',
        'queued build a runner',
        'pending',
        'pause is never cancelled',
        '--json emits that summary as JSON',
        'phase session may not use --all',
        'exits',
        'nonzero and reports which of',
        'the two repository facts landed and which builds were requested',
      ],
      resume: [
        'resume <slug>',
        'does not answer open',
        'ab answer',
        'ab resume --all [--store <ref>] [--json]',
        'durably releases the queued-build hold',
        'turns ticket intake back on',
        'launchable on the next ordinary tick',
        'left to ab answer',
        '--json emits that',
        'A phase session may not',
        'use --all',
      ],
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
        'requires no session identity',
        'only the ambient build',
      ],
      observe: ['followup|refactor|latent-bug', '--files', '--refs', 'not a terminal'],
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

    const dispatch = renderCommandHelp('dispatch')
    expect(renderTopLevelHelp()).not.toContain('ab server')
    expect(dispatch).not.toContain('p         Toggle intake')
    expect(dispatch).not.toContain('selected Harvest workflow or build')
  })

  test('unknown and malformed help requests fail with targeted feedback', async () => {
    for (const command of ['frobnicate', 'server']) {
      const unknown = deps()
      expect(await runCli(['help', command], unknown)).toBe(1)
      expect(unknown.out).toEqual([])
      expect(unknown.err.join('\n')).toContain(`unknown help command "${command}"`)
    }

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
    expect(isSessionlessInvocation(['update', '--help'])).toBe(true)

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
    expect(isSessionlessInvocation(['repository', 'status'])).toBe(true)
    expect(isSessionlessInvocation(['context'])).toBe(false)
    expect(isSessionlessInvocation(['context', '--help', 'extra'])).toBe(false)
    expect(isSessionlessInvocation(['artifact', 'put'])).toBe(false)
    expect(isSessionlessInvocation(['harvest', 'context'])).toBe(false)
  })
})
