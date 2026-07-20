import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig, parseConfig } from './load'

/** The example block from SPEC §16.1, transcribed verbatim. */
const SPEC_EXAMPLE = `[project]
baseBranch = "main"

# Optional; omission is the default text-only behavior.
[dashboardFrames]
provider = "github-release"
repository = "owner/public-review-assets"
releaseId = 123456

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
paths = ["web/**", "src/routes/**"] # optional positive any-match selectors
# always = true                 # mandatory-gate guard; overrides paths

[finalize]
steps = ["release-notes"]       # optional post-steps, failure-tolerant (§5)

[roles.default]                 # reserved repo-wide inheritance base (§9)
runtime = "claude"

[roles.plan]                    # phase role → per-field override (§9)
runtime = "claude"

[roles.code-review]
runtime = "pi"
model = "…"

[policy]
stallRounds = 3
maxVerifyAttempts = 3
maxReconcileAttempts = 3

[dispatcher]
capacity = 3                    # concurrent builds for this repo

[tickets]
source = "file"
readyLabels = ["autobuild"]
readyState = "ready"            # required: the one state a ticket must sit in to dispatch

[harvest]                       # observation back-pressure, owned by dispatch
threshold = 10

[outer]                         # cron schedules for other outer-loop processes
"ingest:sentry" = { cron = "0 */4 * * *" }
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

/**
 * `[tickets].readyState` is required and non-blank (AUT-11), so every config
 * that is not itself exercising the tickets table must supply a minimal file
 * source for parsing to reach the table under test.
 */
const READY = '[tickets]\nsource = "file"\nreadyState = "ready"\n'

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
      dashboardFrames: {
        provider: 'github-release',
        repository: 'owner/public-review-assets',
        releaseId: 123456,
      },
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
          e2e: {
            kind: 'agent',
            skill: 'ab-verify-e2e',
            needsServer: true,
            paths: ['web/**', 'src/routes/**'],
          },
        },
      },
      finalize: { steps: ['release-notes'] },
      roles: {
        default: { runtime: 'claude' },
        plan: { runtime: 'claude' },
        'code-review': { runtime: 'pi', model: '…' },
      },
      policy: {
        stallRounds: 3,
        maxVerifyAttempts: 3,
        maxReconcileAttempts: 3,
        maxReviewRounds: 4,
      },
      dispatcher: { capacity: 3 },
      tickets: {
        source: 'file',
        readyLabels: ['autobuild'],
        readyState: 'ready',
      },
      harvest: { threshold: 10 },
      outer: {
        'ingest:sentry': { cron: '0 */4 * * *' },
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
  test('an empty file fails at tickets.readyState — the gate has no default', () => {
    const error = parseError('')
    expect(error.message).toContain('tickets.readyState')
    expect(error.message).toContain('is required')
  })

  test('a minimal valid [tickets] yields every other table default', () => {
    expect(parseConfig(READY)).toEqual({
      project: { baseBranch: 'main' },
      commands: {},
      verify: { steps: [], stepConfigs: {} },
      finalize: { steps: [] },
      roles: {},
      policy: {
        stallRounds: 3,
        maxVerifyAttempts: 3,
        maxReconcileAttempts: 3,
        maxReviewRounds: 4,
      },
      dispatcher: { capacity: 1 },
      tickets: { source: 'file', readyState: 'ready' },
      harvest: { threshold: 10 },
      outer: {},
    })
  })

  test('server.readyTimeout defaults to 60 seconds', () => {
    const config = parseConfig(
      `${READY}[server]\nstart = "bun dev"\nurl = "http://localhost:3000"\n`,
    )
    expect(config.server).toEqual({
      start: 'bun dev',
      url: 'http://localhost:3000',
      readyTimeout: 60,
    })
  })

  test('agent step needsServer defaults to false (and then needs no [server])', () => {
    const config = parseConfig(
      `${READY}[verify]\nsteps = ["e2e"]\n[verify.e2e]\nkind = "agent"\nskill = "ab-verify-e2e"\n`,
    )
    expect(config.verify.stepConfigs['e2e']).toEqual({
      kind: 'agent',
      skill: 'ab-verify-e2e',
      needsServer: false,
    })
  })

  test('partial [policy] keeps per-key defaults, including implicit maxReviewRounds', () => {
    const config = parseConfig(`${READY}[policy]\nstallRounds = 7\n`)
    expect(config.policy).toEqual({
      stallRounds: 7,
      maxVerifyAttempts: 3,
      maxReconcileAttempts: 3,
      maxReviewRounds: 4,
    })
  })
})

describe('parseConfig — optional dashboard frame hosting', () => {
  test('accepts one explicit public GitHub release target and otherwise stays off', () => {
    const enabled = parseConfig(`${READY}
[dashboardFrames]
provider = "github-release"
repository = "acme/review-assets"
releaseId = 123456
`)
    expect(enabled.dashboardFrames).toEqual({
      provider: 'github-release',
      repository: 'acme/review-assets',
      releaseId: 123456,
    })
    expect(parseConfig(READY).dashboardFrames).toBeUndefined()
  })

  test('is strict and rejects unsupported providers or unknown keys', () => {
    for (const table of [
      '[dashboardFrames]\nprovider = "s3"\nrepository = "acme/assets"\nreleaseId = 1\n',
      '[dashboardFrames]\nprovider = "github-release"\nrepository = "acme/assets"\nreleaseId = 1\nbucket = "frames"\n',
    ]) {
      expect(() => parseConfig(`${READY}${table}`)).toThrow(/dashboardFrames/)
    }
  })

  test('rejects malformed repository pairs and non-positive release ids', () => {
    for (const repository of ['', 'acme', 'acme/assets/extra', 'acme /assets']) {
      expect(() =>
        parseConfig(`${READY}
[dashboardFrames]
provider = "github-release"
repository = ${JSON.stringify(repository)}
releaseId = 1
`),
      ).toThrow(/dashboardFrames\.repository/)
    }
    for (const releaseId of [0, -1]) {
      expect(() =>
        parseConfig(`${READY}
[dashboardFrames]
provider = "github-release"
repository = "acme/assets"
releaseId = ${releaseId}
`),
      ).toThrow(/dashboardFrames\.releaseId/)
    }
  })
})

describe('parseConfig — verify path applicability', () => {
  test('check and agent steps accept any-match paths and an explicit always guard', () => {
    const parsed = parseConfig(`${READY}
[commands]
test = "bun test"

[verify]
steps = ["unit", "dashboard"]

[verify.unit]
kind = "check"
command = "test"
paths = ["src/**/*.ts", "package.json"]
always = false

[verify.dashboard]
kind = "agent"
skill = "ab-verify-dashboard"
paths = ["src/cli/dashboard/**"]
always = true
`)
    expect(parsed.verify.stepConfigs).toEqual({
      unit: {
        kind: 'check',
        command: 'test',
        paths: ['src/**/*.ts', 'package.json'],
        always: false,
      },
      dashboard: {
        kind: 'agent',
        skill: 'ab-verify-dashboard',
        needsServer: false,
        paths: ['src/cli/dashboard/**'],
        always: true,
      },
    })
  })

  test('old step tables retain their exact output shape when conditions are absent', () => {
    const parsed = parseConfig(`${READY}
[commands]
test = "bun test"
[verify]
steps = ["unit", "e2e"]
[verify.unit]
kind = "check"
command = "test"
[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
`)
    expect(parsed.verify.stepConfigs).toEqual({
      unit: { kind: 'check', command: 'test' },
      e2e: { kind: 'agent', skill: 'ab-verify-e2e', needsServer: false },
    })
  })

  test('rejects empty, unsafe, malformed, and unsupported selectors at the named step', () => {
    const invalid: Array<[string, string]> = [
      ['[]', 'at least one'],
      ['[""]', 'nonempty'],
      ['["/src/**"]', 'repository-relative'],
      ['["C:/src/**"]', 'repository-relative'],
      ['["src/../secret"]', 'traversal'],
      ['["src//file.ts"]', 'empty path segments'],
      ['["src/**file.ts"]', 'complete path segment'],
      ['["src/***/file.ts"]', 'complete path segment'],
      ['["src/[ab].ts"]', 'character classes'],
      ['["src/{a,b}.ts"]', 'brace expansion'],
      ['["!src/**"]', 'negation'],
      ['["src/@(a|b).ts"]', 'extglobs'],
      ['["src\\\\file.ts"]', 'backslashes'],
    ]
    for (const [value, expected] of invalid) {
      const error = parseError(`${READY}
[commands]
test = "bun test"
[verify]
steps = ["dashboard"]
[verify.dashboard]
kind = "check"
command = "test"
paths = ${value}
`)
      expect(error.message).toContain('verify.dashboard')
      expect(error.message).toContain(expected)
    }
  })

  test('always does not hide a malformed paths declaration', () => {
    const error = parseError(`${READY}
[commands]
test = "bun test"
[verify]
steps = ["dashboard"]
[verify.dashboard]
kind = "check"
command = "test"
always = true
paths = ["../dashboard/**"]
`)
    expect(error.message).toContain('verify.dashboard.paths[0]')
    expect(error.message).toContain('traversal')
  })

  test('rejects wrong condition types and misspelled keys instead of disabling a gate', () => {
    const wrongPaths = parseError(`${READY}
[commands]
test = "bun test"
[verify]
steps = ["unit"]
[verify.unit]
kind = "check"
command = "test"
paths = "src/**"
`)
    expect(wrongPaths.message).toContain('verify.unit.paths')

    const wrongAlways = parseError(`${READY}
[commands]
test = "bun test"
[verify]
steps = ["unit"]
[verify.unit]
kind = "check"
command = "test"
always = "yes"
`)
    expect(wrongAlways.message).toContain('verify.unit.always')

    const typo = parseError(`${READY}
[commands]
test = "bun test"
[verify]
steps = ["unit"]
[verify.unit]
kind = "check"
command = "test"
path = ["src/**"]
`)
    expect(typo.message).toContain('verify.unit')
    expect(typo.message).toContain('Unrecognized key')
  })
})

describe('parseConfig — harvest back-pressure', () => {
  test('threshold defaults to 10 and accepts a positive override', () => {
    expect(parseConfig(READY).harvest.threshold).toBe(10)
    expect(
      parseConfig(`${READY}[harvest]\nthreshold = 3\n`).harvest.threshold,
    ).toBe(3)
  })

  test('rejects the legacy [outer].harvest cron with the replacement knob', () => {
    const error = parseError(
      `${READY}[outer]\nharvest = { cron = "0 9 * * *" }\n`,
    )
    expect(error.message).toContain('outer.harvest')
    expect(error.message).toContain('[harvest].threshold')
  })

  test('other scheduled ingesters remain valid', () => {
    expect(
      parseConfig(
        `${READY}[outer]\n"ingest:sentry" = { cron = "0 */4 * * *" }\n`,
      ).outer,
    ).toEqual({ 'ingest:sentry': { cron: '0 */4 * * *' } })
  })
})

describe('parseConfig — cross-validation', () => {
  test('a steps entry without a [verify.<step>] table is an error with path and remedy', () => {
    const error = parseError(`${READY}[verify]\nsteps = ["types"]\n`)
    expect(error.message).toContain('verify.steps[0]')
    expect(error.message).toContain('has no [verify.types] table')
    expect(error.message).toContain('kind = "check"')
    expect(error.message).toContain('kind = "agent"')
  })

  test('an orphaned [verify.<step>] table is an error too', () => {
    const error = parseError(
      `${READY}[commands]\ntypecheck = "tsc"\n\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n`,
    )
    expect(error.message).toContain('verify.types')
    expect(error.message).toContain('"types" is not listed in verify.steps')
    expect(error.message).toContain('add "types" to verify.steps or remove the table')
  })

  test('a check step whose command is not in [commands] is an error naming the known commands', () => {
    const error = parseError(
      `${READY}[commands]\nlint = "bun lint"\n\n[verify]\nsteps = ["types"]\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n`,
    )
    expect(error.message).toContain('verify.types.command')
    expect(error.message).toContain('"typecheck" does not name a key in [commands]')
    expect(error.message).toContain('known commands: lint')
  })

  test('a dangling command ref with no [commands] at all says so', () => {
    const error = parseError(
      `${READY}[verify]\nsteps = ["types"]\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n`,
    )
    expect(error.message).toContain('verify.types.command')
    expect(error.message).toContain('[commands] has no entries')
  })

  test('needsServer = true without a [server] table is an error', () => {
    const error = parseError(
      `${READY}[verify]\nsteps = ["e2e"]\n[verify.e2e]\nkind = "agent"\nskill = "ab-verify-e2e"\nneedsServer = true\n`,
    )
    expect(error.message).toContain('verify.e2e.needsServer')
    expect(error.message).toContain('requires a [server] table (start, url)')
  })

  test('an empty finalize.steps entry is an error at its index', () => {
    const error = parseError(`${READY}[finalize]\nsteps = ["release-notes", ""]\n`)
    expect(error.message).toContain('finalize.steps[1]')
    expect(error.message).toContain('nonempty')
  })
})

describe('parseConfig — [tickets]', () => {
  test('a valid linear source parses, claimedState optional', () => {
    const config = parseConfig(
      '[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\n',
    )
    expect(config.tickets).toEqual({
      source: 'linear',
      teamKey: 'ENG',
      readyState: 'Todo',
    })
  })

  test('a valid file source parses', () => {
    const config = parseConfig(
      '[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
    )
    expect(config.tickets).toEqual({
      source: 'file',
      dir: 'tickets',
      readyState: 'ready',
    })
  })

  test('an absent table fails specifically at tickets.readyState', () => {
    const error = parseError('[dispatcher]\ncapacity = 2\n')
    expect(error.message).toContain('tickets.readyState')
    expect(error.message).toContain('is required')
    expect(error.message).toContain('every ticket from the source eligible')
  })

  test('the default leaves dir undefined — the factory decides, and only it knows it was defaulted', () => {
    expect(parseConfig(READY).tickets.dir).toBeUndefined()
  })

  test('a present table is not clobbered by the file-source prefault input', () => {
    const config = parseConfig(
      '[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\n',
    )
    expect(config.tickets.source).toBe('linear')
  })

  test('linear without teamKey is an error with path and remedy', () => {
    const error = parseError('[tickets]\nsource = "linear"\nreadyState = "Todo"\n')
    expect(error.message).toContain('tickets.teamKey')
    expect(error.message).toContain('requires teamKey')
  })

  test('file without dir parses — dir is optional, defaulting to .autobuild/tickets', () => {
    expect(parseConfig(READY).tickets).toEqual({
      source: 'file',
      readyState: 'ready',
    })
  })

  test('dir on a linear source is rejected', () => {
    const error = parseError(
      '[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\ndir = "tickets"\n',
    )
    expect(error.message).toContain('tickets.dir')
    expect(error.message).toContain('applies only to source = "file"')
  })

  test('teamKey and claimedState on a file source are rejected', () => {
    const error = parseError(
      '[tickets]\nsource = "file"\nreadyState = "ready"\ndir = "tickets"\nteamKey = "ENG"\nclaimedState = "Doing"\n',
    )
    expect(error.message).toContain('tickets.teamKey')
    expect(error.message).toContain('tickets.claimedState')
    expect(error.message).toContain('applies only to source = "linear"')
  })

  test('an unknown source is rejected', () => {
    const error = parseError('[tickets]\nsource = "jira"\nreadyState = "Ready"\n')
    expect(error.message).toContain('tickets.source')
  })

  test('createState is accepted on both sources — absent means provider default', () => {
    const linear = parseConfig(
      '[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\ncreateState = "Triage"\n',
    )
    expect(linear.tickets.createState).toBe('Triage')
    const file = parseConfig(
      '[tickets]\nsource = "file"\nreadyState = "ready"\ndir = "tickets"\ncreateState = "Backlog"\n',
    )
    expect(file.tickets.createState).toBe('Backlog')
    expect(
      parseConfig(
        '[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\n',
      ).tickets.createState,
    ).toBeUndefined()
  })

  test('triageState is accepted on both sources — absent means provider default', () => {
    const linear = parseConfig(
      '[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\ntriageState = "Backlog"\n',
    )
    expect(linear.tickets.triageState).toBe('Backlog')
    const file = parseConfig(
      '[tickets]\nsource = "file"\nreadyState = "ready"\ntriageState = "Triage"\n',
    )
    expect(file.tickets.triageState).toBe('Triage')
    expect(
      parseConfig(
        '[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\n',
      ).tickets.triageState,
    ).toBeUndefined()
  })
})

describe('parseConfig — [tickets] readiness', () => {
  test('readyState is required and reports the new path', () => {
    for (const toml of ['', '[tickets]\nsource = "file"\n']) {
      const error = parseError(toml)
      expect(error.message).toContain('tickets.readyState')
      expect(error.message).toContain('is required')
      expect(error.message).toContain('every ticket from the source eligible')
    }
  })

  test('empty and whitespace-only readyState values are rejected as blank', () => {
    for (const value of ['', '   ']) {
      const error = parseError(
        `[tickets]\nsource = "file"\nreadyState = ${JSON.stringify(value)}\n`,
      )
      expect(error.message).toContain('tickets.readyState')
      expect(error.message).toContain('must not be blank')
    }
  })

  test('readyLabels is optional and absent by default — the source decides its own label gate', () => {
    expect(parseConfig(READY).tickets.readyLabels).toBeUndefined()
  })

  test('readyLabels accepts an explicit empty array and nonempty entries', () => {
    expect(
      parseConfig(
        '[tickets]\nsource = "file"\nreadyState = "Ready"\nreadyLabels = []\n',
      ).tickets.readyLabels,
    ).toEqual([])
    expect(
      parseConfig(
        '[tickets]\nsource = "file"\nreadyState = "Ready"\nreadyLabels = ["urgent"]\n',
      ).tickets.readyLabels,
    ).toEqual(['urgent'])
  })

  test('readyLabels rejects blank entries', () => {
    const error = parseError(
      '[tickets]\nsource = "file"\nreadyState = "Ready"\nreadyLabels = [""]\n',
    )
    expect(error.message).toContain('tickets.readyLabels[0]')
  })

  test('each old dispatcher key is rejected with its new qualified home', () => {
    for (const [key, value] of [
      ['readyState', '"Ready"'],
      ['readyLabels', '["autobuild"]'],
    ] as const) {
      const error = parseError(`${READY}[dispatcher]\n${key} = ${value}\n`)
      expect(error.message).toContain(`[dispatcher].${key}`)
      expect(error.message).toContain(`[tickets].${key}`)
      expect(error.message).toContain('has moved')
    }
  })

  test('old keys still fail when valid new values exist, and all bad keys are named', () => {
    const error = parseError(
      `${READY}[dispatcher]\nreadyState = "Old"\nreadyLabels = []\ncapcity = 2\n`,
    )
    expect(error.message).toContain('[dispatcher].readyState')
    expect(error.message).toContain('[tickets].readyState')
    expect(error.message).toContain('[dispatcher].readyLabels')
    expect(error.message).toContain('[tickets].readyLabels')
    expect(error.message).toContain('"capcity"')
  })
})

describe('parseConfig — strictness (a typo must not silently disable a verifier)', () => {
  test('unknown top-level table is rejected, naming the known tables', () => {
    const error = parseError('[polcy]\nstallRounds = 3\n')
    expect(error.message).toContain('"polcy"')
    expect(error.message).toContain(
      'known tables: project, dashboardFrames, commands, server, verify',
    )
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

  test('the old [roles] `runner` key is now an unknown-key error (re-keyed to runtime)', () => {
    const error = parseError(`${READY}[roles]\nplan = { runner = "claude" }\n`)
    expect(error.message).toContain('roles')
    expect(error.message).toContain('"runner"')
  })

  test('unknown key inside [roles.default] is rejected', () => {
    const error = parseError(
      `${READY}[roles.default]\nruntime = "claude"\nmdel = "x"\n`,
    )
    expect(error.message).toContain('roles.default')
    expect(error.message).toContain('"mdel"')
  })
})

describe('parseConfig — [roles.default] + phase roles (§9)', () => {
  test('[roles.default] accepts all three role fields', () => {
    const config = parseConfig(
      `${READY}[roles.default]\n` +
        `runtime = "pi"\n` +
        `model = "kimi-k3"\n` +
        `extensions = ["subagents", "web-access"]\n`,
    )
    expect(config.roles.default).toEqual({
      runtime: 'pi',
      model: 'kimi-k3',
      extensions: ['subagents', 'web-access'],
    })
  })

  test('[roles.default] is optional and may be explicitly empty', () => {
    expect(parseConfig(READY).roles).toEqual({})
    expect(parseConfig(`${READY}[roles.default]\n`).roles).toEqual({ default: {} })
  })

  test('legacy [agent] is rejected with its [roles.default] replacement', () => {
    const error = parseError(`${READY}[agent]\nruntime = "pi"\n`)
    expect(error.message).toContain('[agent]')
    expect(error.message).toContain('removed')
    expect(error.message).toContain('[roles.default]')
    expect(error.message).toContain('default entry in [roles]')
  })

  test('[roles] entries accept runtime, model, both, or neither', () => {
    const config = parseConfig(
      `${READY}[roles]\n` +
        `plan = { model = "gpt-5.6-sol" }\n` +
        `code-review = { runtime = "claude", model = "claude-opus-4-5" }\n` +
        `implement = { runtime = "pi" }\n` +
        `finalize = {}\n`,
    )
    expect(config.roles).toEqual({
      plan: { model: 'gpt-5.6-sol' },
      'code-review': { runtime: 'claude', model: 'claude-opus-4-5' },
      implement: { runtime: 'pi' },
      finalize: {},
    })
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
      await writeFile(good, `${READY}[project]\nbaseBranch = "trunk"\n`)
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
