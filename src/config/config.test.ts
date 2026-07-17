import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig, parseConfig } from './load'

/** The example block from SPEC §16.1, transcribed verbatim. */
const SPEC_EXAMPLE = `[project]
baseBranch = "main"

[commands]                      # deterministic verbs the kernel may run
setup = "bun install"           # after provision / sandbox rehydrate (§15.6-C)
lint = "bun lint"
typecheck = "bun tsc --noEmit"
test = "bun test"

[server]                        # dev-server lifecycle — see §16.2
start = "bun dev"
url = "http://localhost:3000"   # readiness probe target
readyTimeout = 60               # seconds

[verify]
steps = ["types", "unit", "e2e"]
[verify.types]
kind = "check"                  # deterministic: command + pass/fail
command = "typecheck"           # ref into [commands]
[verify.e2e]
kind = "agent"                  # agent-verify: skill + verdict schema
skill = "ab-verify-e2e"
needsServer = true

[finalize]
steps = ["release-notes"]       # optional post-steps, failure-tolerant (§5)

[roles]                         # role → runner/model routing (v1 harnessMap, generalized)
plan = { runner = "claude" }
code-review = { runner = "pi", model = "…" }

[policy]
stallRounds = 3
maxVerifyAttempts = 3
maxReconcileAttempts = 3

[dispatcher]
capacity = 3                    # concurrent builds for this repo
readyLabels = ["autobuild"]

[outer]                         # cron schedules for outer-loop processes
"ingest:sentry" = { cron = "0 */4 * * *" }
harvest = { cron = "0 9 * * *" }
`

/**
 * The SPEC example lists "unit" in verify.steps but defines no [verify.unit]
 * table — under §16.1's own strictness rule that is an error (pinned below).
 * Supplying the one missing table lets every other field be asserted.
 */
const SPEC_EXAMPLE_WITH_UNIT = SPEC_EXAMPLE.replace(
  '[verify.types]',
  '[verify.unit]\nkind = "check"\ncommand = "test"\n\n[verify.types]',
)

function parseError(toml: string, source?: string): ConfigError {
  try {
    parseConfig(toml, source)
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('expected parseConfig to throw ConfigError')
}

describe('parseConfig — SPEC §16.1 example', () => {
  test('every field lands where expected', () => {
    const config = parseConfig(SPEC_EXAMPLE_WITH_UNIT)
    expect(config).toEqual({
      project: { baseBranch: 'main' },
      commands: {
        setup: 'bun install',
        lint: 'bun lint',
        typecheck: 'bun tsc --noEmit',
        test: 'bun test',
      },
      server: { start: 'bun dev', url: 'http://localhost:3000', readyTimeout: 60 },
      verify: {
        steps: ['types', 'unit', 'e2e'],
        stepConfigs: {
          types: { kind: 'check', command: 'typecheck' },
          unit: { kind: 'check', command: 'test' },
          e2e: { kind: 'agent', skill: 'ab-verify-e2e', needsServer: true },
        },
      },
      finalize: { steps: ['release-notes'] },
      roles: {
        plan: { runner: 'claude' },
        'code-review': { runner: 'pi', model: '…' },
      },
      policy: {
        stallRounds: 3,
        maxVerifyAttempts: 3,
        maxReconcileAttempts: 3,
        maxReviewRounds: 5,
      },
      dispatcher: { capacity: 3, readyLabels: ['autobuild'] },
      tickets: { source: 'file' },
      outer: {
        'ingest:sentry': { cron: '0 */4 * * *' },
        harvest: { cron: '0 9 * * *' },
      },
    })
  })

  test('pins the SPEC inconsistency: the strictly verbatim block lists "unit" without a [verify.unit] table', () => {
    const error = parseError(SPEC_EXAMPLE)
    expect(error.message).toContain('verify.steps[1]')
    expect(error.message).toContain('has no [verify.unit] table')
  })
})

describe('parseConfig — defaults', () => {
  test('empty file yields all defaults', () => {
    expect(parseConfig('')).toEqual({
      project: { baseBranch: 'main' },
      commands: {},
      verify: { steps: [], stepConfigs: {} },
      finalize: { steps: [] },
      roles: {},
      policy: {
        stallRounds: 3,
        maxVerifyAttempts: 3,
        maxReconcileAttempts: 3,
        maxReviewRounds: 5,
      },
      dispatcher: { capacity: 1 },
      tickets: { source: 'file' },
      outer: {},
    })
  })

  test('server.readyTimeout defaults to 60 seconds', () => {
    const config = parseConfig('[server]\nstart = "bun dev"\nurl = "http://localhost:3000"\n')
    expect(config.server).toEqual({
      start: 'bun dev',
      url: 'http://localhost:3000',
      readyTimeout: 60,
    })
  })

  test('agent step needsServer defaults to false (and then needs no [server])', () => {
    const config = parseConfig(
      '[verify]\nsteps = ["e2e"]\n[verify.e2e]\nkind = "agent"\nskill = "ab-verify-e2e"\n',
    )
    expect(config.verify.stepConfigs['e2e']).toEqual({
      kind: 'agent',
      skill: 'ab-verify-e2e',
      needsServer: false,
    })
  })

  test('partial [policy] keeps per-key defaults, including implicit maxReviewRounds', () => {
    const config = parseConfig('[policy]\nstallRounds = 7\n')
    expect(config.policy).toEqual({
      stallRounds: 7,
      maxVerifyAttempts: 3,
      maxReconcileAttempts: 3,
      maxReviewRounds: 5,
    })
  })
})

describe('parseConfig — cross-validation', () => {
  test('a steps entry without a [verify.<step>] table is an error with path and remedy', () => {
    const error = parseError('[verify]\nsteps = ["types"]\n')
    expect(error.message).toContain('verify.steps[0]')
    expect(error.message).toContain('has no [verify.types] table')
    expect(error.message).toContain('kind = "check"')
    expect(error.message).toContain('kind = "agent"')
  })

  test('an orphaned [verify.<step>] table is an error too', () => {
    const error = parseError(
      '[commands]\ntypecheck = "tsc"\n\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n',
    )
    expect(error.message).toContain('verify.types')
    expect(error.message).toContain('"types" is not listed in verify.steps')
    expect(error.message).toContain('add "types" to verify.steps or remove the table')
  })

  test('a check step whose command is not in [commands] is an error naming the known commands', () => {
    const error = parseError(
      '[commands]\nlint = "bun lint"\n\n[verify]\nsteps = ["types"]\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n',
    )
    expect(error.message).toContain('verify.types.command')
    expect(error.message).toContain('"typecheck" does not name a key in [commands]')
    expect(error.message).toContain('known commands: lint')
  })

  test('a dangling command ref with no [commands] at all says so', () => {
    const error = parseError(
      '[verify]\nsteps = ["types"]\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n',
    )
    expect(error.message).toContain('verify.types.command')
    expect(error.message).toContain('[commands] has no entries')
  })

  test('needsServer = true without a [server] table is an error', () => {
    const error = parseError(
      '[verify]\nsteps = ["e2e"]\n[verify.e2e]\nkind = "agent"\nskill = "ab-verify-e2e"\nneedsServer = true\n',
    )
    expect(error.message).toContain('verify.e2e.needsServer')
    expect(error.message).toContain('requires a [server] table (start, url)')
  })

  test('an empty finalize.steps entry is an error at its index', () => {
    const error = parseError('[finalize]\nsteps = ["release-notes", ""]\n')
    expect(error.message).toContain('finalize.steps[1]')
    expect(error.message).toContain('nonempty')
  })
})

describe('parseConfig — [tickets]', () => {
  test('a valid linear source parses, claimedState optional', () => {
    const config = parseConfig('[tickets]\nsource = "linear"\nteamKey = "ENG"\n')
    expect(config.tickets).toEqual({ source: 'linear', teamKey: 'ENG' })
  })

  test('a valid file source parses', () => {
    const config = parseConfig('[tickets]\nsource = "file"\ndir = "tickets"\n')
    expect(config.tickets).toEqual({ source: 'file', dir: 'tickets' })
  })

  test('absent table means the local file tracker — a repo dispatches with no config', () => {
    expect(parseConfig('').tickets).toEqual({ source: 'file' })
  })

  test('the default leaves dir undefined — the factory decides, and only it knows it was defaulted', () => {
    expect(parseConfig('').tickets.dir).toBeUndefined()
  })

  test('a present-but-partial table is not clobbered by the default', () => {
    expect(parseConfig('[tickets]\nsource = "linear"\nteamKey = "ENG"\n').tickets).toEqual({
      source: 'linear',
      teamKey: 'ENG',
    })
  })

  test('linear without teamKey is an error with path and remedy', () => {
    const error = parseError('[tickets]\nsource = "linear"\n')
    expect(error.message).toContain('tickets.teamKey')
    expect(error.message).toContain('requires teamKey')
  })

  test('file without dir parses — dir is optional, defaulting to .autobuild/tickets', () => {
    expect(parseConfig('[tickets]\nsource = "file"\n').tickets).toEqual({
      source: 'file',
    })
  })

  test('dir on a linear source is rejected', () => {
    const error = parseError(
      '[tickets]\nsource = "linear"\nteamKey = "ENG"\ndir = "tickets"\n',
    )
    expect(error.message).toContain('tickets.dir')
    expect(error.message).toContain('applies only to source = "file"')
  })

  test('teamKey and claimedState on a file source are rejected', () => {
    const error = parseError(
      '[tickets]\nsource = "file"\ndir = "tickets"\nteamKey = "ENG"\nclaimedState = "Doing"\n',
    )
    expect(error.message).toContain('tickets.teamKey')
    expect(error.message).toContain('tickets.claimedState')
    expect(error.message).toContain('applies only to source = "linear"')
  })

  test('an unknown source is rejected', () => {
    const error = parseError('[tickets]\nsource = "jira"\n')
    expect(error.message).toContain('tickets.source')
  })

  test('createState is accepted on both sources — absent means provider default', () => {
    const linear = parseConfig(
      '[tickets]\nsource = "linear"\nteamKey = "ENG"\ncreateState = "Triage"\n',
    )
    expect(linear.tickets?.createState).toBe('Triage')
    const file = parseConfig(
      '[tickets]\nsource = "file"\ndir = "tickets"\ncreateState = "Backlog"\n',
    )
    expect(file.tickets?.createState).toBe('Backlog')
    expect(
      parseConfig('[tickets]\nsource = "linear"\nteamKey = "ENG"\n').tickets
        ?.createState,
    ).toBeUndefined()
  })

  test('triageState is accepted on both sources — absent means provider default', () => {
    const linear = parseConfig(
      '[tickets]\nsource = "linear"\nteamKey = "ENG"\ntriageState = "Backlog"\n',
    )
    expect(linear.tickets?.triageState).toBe('Backlog')
    const file = parseConfig('[tickets]\nsource = "file"\ntriageState = "Triage"\n')
    expect(file.tickets?.triageState).toBe('Triage')
    expect(
      parseConfig('[tickets]\nsource = "linear"\nteamKey = "ENG"\n').tickets
        ?.triageState,
    ).toBeUndefined()
  })
})

describe('parseConfig — [dispatcher] readiness', () => {
  test('readyState is optional and absent by default', () => {
    expect(parseConfig('').dispatcher.readyState).toBeUndefined()
  })

  test('readyLabels is optional and absent by default — the source decides its own gate', () => {
    // Not [] and not ['autobuild']: the schema records "unset" and readyCriteria
    // (src/processes/dispatcher.ts) resolves it per source. A default here would
    // label-gate the file tracker's ready/ directory.
    expect(parseConfig('').dispatcher.readyLabels).toBeUndefined()
  })

  test('readyState parses alongside readyLabels', () => {
    const config = parseConfig(
      '[dispatcher]\nreadyLabels = []\nreadyState = "Ready"\n',
    )
    expect(config.dispatcher.readyState).toBe('Ready')
    expect(config.dispatcher.readyLabels).toEqual([])
  })
})

describe('parseConfig — strictness (a typo must not silently disable a verifier)', () => {
  test('unknown top-level table is rejected, naming the known tables', () => {
    const error = parseError('[polcy]\nstallRounds = 3\n')
    expect(error.message).toContain('"polcy"')
    expect(error.message).toContain('known tables: project, commands, server, verify')
  })

  test('unknown key inside [policy] is rejected', () => {
    const error = parseError('[policy]\nstallRound = 3\n')
    expect(error.message).toContain('policy')
    expect(error.message).toContain('"stallRound"')
  })

  test('unknown key inside a [verify.<step>] table is rejected', () => {
    const error = parseError(
      '[commands]\ntypecheck = "tsc"\n\n[verify]\nsteps = ["types"]\n[verify.types]\nkind = "check"\ncommand = "typecheck"\ncomand = "oops"\n',
    )
    expect(error.message).toContain('verify.types')
    expect(error.message).toContain('"comand"')
  })

  test('a non-table value inside [verify] is rejected as a malformed step table', () => {
    const error = parseError('[verify]\nsteps = []\nfoo = "bar"\n')
    expect(error.message).toContain('verify.foo')
  })

  test('an unknown kind in a step table is rejected', () => {
    const error = parseError(
      '[verify]\nsteps = ["x"]\n[verify.x]\nkind = "chek"\ncommand = "y"\n',
    )
    expect(error.message).toContain('verify.x')
  })
})

describe('parseConfig — TOML syntax errors', () => {
  test('surface with the given source name', () => {
    const error = parseError('[unclosed\n', 'repo/autobuild.toml')
    expect(error.message).toContain('repo/autobuild.toml')
    expect(error.message).toContain('TOML syntax error')
  })

  test('default source name is autobuild.toml', () => {
    const error = parseError('=\n')
    expect(error.message).toContain('autobuild.toml')
  })
})

describe('loadConfig', () => {
  test('reads from disk and reports the path as the source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-config-test-'))
    try {
      const good = join(dir, 'autobuild.toml')
      await writeFile(good, '[project]\nbaseBranch = "trunk"\n')
      const config = await loadConfig(good)
      expect(config.project.baseBranch).toBe('trunk')

      const bad = join(dir, 'bad.toml')
      await writeFile(bad, '[polcy]\n')
      await expect(loadConfig(bad)).rejects.toThrow('bad.toml')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
