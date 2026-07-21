import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig, parseConfig } from './load'

const READY = '[tickets]\nsource = "file"\nreadyState = "ready"\n'

const COMPLETE_EXAMPLE = `baseBranch = "main"
capacity = 3

[pr.imageHost]
provider = "github-release"
repository = "owner/public-review-assets"
releaseId = 123456

[commands]
setup = "bun install"
lint = "bun lint"
typecheck = "bun tsc --noEmit"
test = "bun test"
publish = "bun run publish"

[server]
start = "bun dev"
url = "http://localhost:3000"
readyTimeout = 60

[verify]
steps = ["types", "unit", "e2e"]

[verify.types]
kind = "check"
command = "typecheck"

[verify.unit]
kind = "check"
command = "test"

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
needsServer = true
paths = ["web/**", "src/routes/**"]

[finalize]
steps = ["publish", "release-notes"]

[finalize.publish]
kind = "check"
command = "publish"

[finalize.release-notes]
kind = "agent"
skill = "ab-release-notes"

[roles.default]
runtime = "claude"

[roles.code-review]
runtime = "pi"
model = "kimi-k3"

[policy]
stallRounds = 3
maxVerifyAttempts = 3
maxReconcileAttempts = 3
maxReviewRounds = 4
harvestThreshold = 7

[tickets]
source = "file"
readyLabels = ["autobuild"]
readyState = "ready"
`

function parseError(toml: string, source?: string): ConfigError {
  try {
    parseConfig(toml, source)
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error('expected parseConfig to throw ConfigError')
}

describe('parseConfig — complete flattened surface', () => {
  test('every field lands where expected', () => {
    expect(parseConfig(COMPLETE_EXAMPLE)).toEqual({
      baseBranch: 'main',
      capacity: 3,
      pr: {
        imageHost: {
          provider: 'github-release',
          repository: 'owner/public-review-assets',
          releaseId: 123456,
        },
      },
      commands: {
        setup: 'bun install',
        lint: 'bun lint',
        typecheck: 'bun tsc --noEmit',
        test: 'bun test',
        publish: 'bun run publish',
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
      finalize: {
        steps: ['publish', 'release-notes'],
        stepConfigs: {
          publish: { kind: 'check', command: 'publish' },
          'release-notes': { kind: 'agent', skill: 'ab-release-notes' },
        },
      },
      roles: {
        default: { runtime: 'claude' },
        'code-review': { runtime: 'pi', model: 'kimi-k3' },
      },
      policy: {
        stallRounds: 3,
        maxVerifyAttempts: 3,
        maxReconcileAttempts: 3,
        maxReviewRounds: 4,
        harvestThreshold: 7,
      },
      tickets: {
        source: 'file',
        readyLabels: ['autobuild'],
        readyState: 'ready',
      },
    })
  })
})

describe('parseConfig — defaults', () => {
  test('an empty file fails at tickets.readyState — the gate has no default', () => {
    const error = parseError('')
    expect(error.message).toContain('tickets.readyState')
    expect(error.message).toContain('is required')
  })

  test('a minimal valid [tickets] yields every other default', () => {
    expect(parseConfig(READY)).toEqual({
      baseBranch: 'main',
      capacity: 1,
      commands: {},
      verify: { steps: [], stepConfigs: {} },
      finalize: { steps: [], stepConfigs: {} },
      roles: {},
      policy: {
        stallRounds: 3,
        maxVerifyAttempts: 3,
        maxReconcileAttempts: 3,
        maxReviewRounds: 4,
        harvestThreshold: 5,
      },
      tickets: { source: 'file', readyState: 'ready' },
    })
  })

  test('top-level scalars and positive numeric knobs accept overrides', () => {
    const config = parseConfig(`baseBranch = "trunk"
capacity = 4
${READY}
[policy]
harvestThreshold = 2
`)
    expect(config.baseBranch).toBe('trunk')
    expect(config.capacity).toBe(4)
    expect(config.policy.harvestThreshold).toBe(2)
  })

  test('root and policy numeric values must be positive integers', () => {
    for (const [field, value] of [
      ['capacity', '0'],
      ['capacity', '1.5'],
    ]) {
      expect(() => parseConfig(`${field} = ${value}\n${READY}`)).toThrow(field)
    }
    for (const value of ['0', '-1', '1.5']) {
      expect(() =>
        parseConfig(`${READY}[policy]\nharvestThreshold = ${value}\n`),
      ).toThrow(/policy\.harvestThreshold/)
    }
  })

  test('server and verify-agent defaults remain intact', () => {
    const config = parseConfig(`${READY}
[server]
start = "bun dev"
url = "http://localhost:3000"

[verify]
steps = ["e2e"]
[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
`)
    expect(config.server?.readyTimeout).toBe(60)
    expect(config.verify.stepConfigs.e2e).toEqual({
      kind: 'agent',
      skill: 'ab-verify-e2e',
      needsServer: false,
    })
  })

  test('partial [policy] keeps every other per-key default', () => {
    expect(parseConfig(`${READY}[policy]\nstallRounds = 7\n`).policy).toEqual({
      stallRounds: 7,
      maxVerifyAttempts: 3,
      maxReconcileAttempts: 3,
      maxReviewRounds: 4,
      harvestThreshold: 5,
    })
  })
})

describe('parseConfig — optional PR image hosting', () => {
  test('accepts one explicit target and otherwise stays off', () => {
    const enabled = parseConfig(`${READY}
[pr.imageHost]
provider = "github-release"
repository = "acme/review-assets"
releaseId = 123456
`)
    expect(enabled.pr?.imageHost?.repository).toBe('acme/review-assets')
    expect(parseConfig(READY).pr).toBeUndefined()
  })

  test('is strict and validates provider, repository, and release id', () => {
    expect(() => parseConfig(`${READY}[pr.imageHost]\nprovider = "s3"\nrepository = "a/b"\nreleaseId = 1\n`)).toThrow(/pr\.imageHost/)
    expect(() => parseConfig(`${READY}[pr.imageHost]\nprovider = "github-release"\nrepository = "bad"\nreleaseId = 1\n`)).toThrow(/pr\.imageHost\.repository/)
    expect(() => parseConfig(`${READY}[pr.imageHost]\nprovider = "github-release"\nrepository = "a/b"\nreleaseId = 0\n`)).toThrow(/pr\.imageHost\.releaseId/)
    expect(() => parseConfig(`${READY}[pr]\nunknown = true\n`)).toThrow(/pr/)
  })

  test('rejects the removed dashboardFrames table', () => {
    expect(() => parseConfig(`${READY}[dashboardFrames]\nprovider = "github-release"\nrepository = "a/b"\nreleaseId = 1\n`)).toThrow(/dashboardFrames/)
  })
})

describe('parseConfig — verify path applicability', () => {
  test('check and agent steps accept paths and always', () => {
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
    expect(parsed.verify.stepConfigs.unit).toEqual({
      kind: 'check',
      command: 'test',
      paths: ['src/**/*.ts', 'package.json'],
      always: false,
    })
    expect(parsed.verify.stepConfigs.dashboard).toEqual({
      kind: 'agent',
      skill: 'ab-verify-dashboard',
      needsServer: false,
      paths: ['src/cli/dashboard/**'],
      always: true,
    })
  })

  test('rejects unsafe, malformed, and unsupported selectors at the named step', () => {
    const invalid: Array<[string, string]> = [
      ['[]', 'at least one'],
      ['[""]', 'nonempty'],
      ['["/src/**"]', 'repository-relative'],
      ['["src/../secret"]', 'traversal'],
      ['["src//file.ts"]', 'empty path segments'],
      ['["src/**file.ts"]', 'complete path segment'],
      ['["src/[ab].ts"]', 'character classes'],
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
})

describe('parseConfig — verify cross-validation', () => {
  test('listed-without-table, orphan-table, and missing-command errors name the step', () => {
    const missing = parseError(`${READY}[verify]\nsteps = ["types"]\n`)
    expect(missing.message).toContain('verify.steps[0]')
    expect(missing.message).toContain('[verify.types]')

    const orphan = parseError(`${READY}[commands]\ntypecheck = "tsc"\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n`)
    expect(orphan.message).toContain('verify.types')
    expect(orphan.message).toContain('not listed')

    const command = parseError(`${READY}[verify]\nsteps = ["types"]\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n`)
    expect(command.message).toContain('verify.types.command')
    expect(command.message).toContain('[commands] has no entries')
  })

  test('needsServer = true requires [server]', () => {
    const error = parseError(`${READY}[verify]\nsteps = ["e2e"]\n[verify.e2e]\nkind = "agent"\nskill = "ab-verify-e2e"\nneedsServer = true\n`)
    expect(error.message).toContain('verify.e2e.needsServer')
    expect(error.message).toContain('requires a [server] table')
  })
})

describe('parseConfig — first-class finalize steps', () => {
  test('accepts strict check and agent tables in configured order', () => {
    const config = parseConfig(`${READY}
[commands]
publish = "bun publish"
[finalize]
steps = ["publish", "notes"]
[finalize.publish]
kind = "check"
command = "publish"
[finalize.notes]
kind = "agent"
skill = "custom-release-notes"
`)
    expect(config.finalize).toEqual({
      steps: ['publish', 'notes'],
      stepConfigs: {
        publish: { kind: 'check', command: 'publish' },
        notes: { kind: 'agent', skill: 'custom-release-notes' },
      },
    })
  })

  test('listed-without-table, orphan-table, and missing-command errors name the step', () => {
    const missing = parseError(`${READY}[finalize]\nsteps = ["publish"]\n`)
    expect(missing.message).toContain('finalize.steps[0]')
    expect(missing.message).toContain('[finalize.publish]')

    const orphan = parseError(`${READY}[commands]\npublish = "bun publish"\n[finalize.publish]\nkind = "check"\ncommand = "publish"\n`)
    expect(orphan.message).toContain('finalize.publish')
    expect(orphan.message).toContain('not listed')

    const command = parseError(`${READY}[finalize]\nsteps = ["publish"]\n[finalize.publish]\nkind = "check"\ncommand = "missing"\n`)
    expect(command.message).toContain('finalize.publish.command')
    expect(command.message).toContain('does not name a key in [commands]')
  })

  test('rejects empty entries, malformed kinds, unknown fields, and verify-only fields', () => {
    expect(parseError(`${READY}[finalize]\nsteps = ["notes", ""]\n`).message).toContain('finalize.steps[1]')

    for (const body of [
      'kind = "chek"\ncommand = "publish"',
      'kind = "agent"\nskill = "ab-notes"\nextra = true',
      'kind = "agent"\nskill = "ab-notes"\nneedsServer = true',
      'kind = "check"\ncommand = "publish"\npaths = ["src/**"]',
      'kind = "check"\ncommand = "publish"\nalways = true',
    ]) {
      const error = parseError(`${READY}
[commands]
publish = "bun publish"
[finalize]
steps = ["notes"]
[finalize.notes]
${body}
`)
      expect(error.message).toContain('finalize.notes')
    }
  })
})

describe('parseConfig — [tickets]', () => {
  test('valid file and Linear sources parse', () => {
    expect(parseConfig(READY).tickets).toEqual({ source: 'file', readyState: 'ready' })
    expect(parseConfig('[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\n').tickets).toEqual({
      source: 'linear',
      teamKey: 'ENG',
      readyState: 'Todo',
    })
  })

  test('readyState is mandatory and nonblank', () => {
    expect(parseError('[tickets]\nsource = "file"\n').message).toContain('tickets.readyState')
    expect(parseError('[tickets]\nsource = "file"\nreadyState = "   "\n').message).toContain('must not be blank')
  })

  test('source-specific fields are cross-validated', () => {
    expect(parseError('[tickets]\nsource = "linear"\nreadyState = "Todo"\n').message).toContain('tickets.teamKey')
    expect(parseError('[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\ndir = "tickets"\n').message).toContain('tickets.dir')
    const file = parseError('[tickets]\nsource = "file"\nreadyState = "ready"\nteamKey = "ENG"\nclaimedState = "Doing"\n')
    expect(file.message).toContain('tickets.teamKey')
    expect(file.message).toContain('tickets.claimedState')
  })

  test('readiness labels and lifecycle states retain their surface', () => {
    const config = parseConfig('[tickets]\nsource = "file"\nreadyState = "ready"\nreadyLabels = []\ncreateState = "Triage"\ntriageState = "Triage"\ndir = "tickets"\n')
    expect(config.tickets).toEqual({
      source: 'file',
      readyState: 'ready',
      readyLabels: [],
      createState: 'Triage',
      triageState: 'Triage',
      dir: 'tickets',
    })
  })
})

describe('parseConfig — roles and strictness', () => {
  test('[roles.default] and per-role overrides accept the three axes', () => {
    const config = parseConfig(`${READY}
[roles.default]
runtime = "pi"
model = "kimi-k3"
extensions = ["web-access"]
[roles.plan]
extensions = []
`)
    expect(config.roles).toEqual({
      default: { runtime: 'pi', model: 'kimi-k3', extensions: ['web-access'] },
      plan: { extensions: [] },
    })
  })

  test('unknown root/table/step keys are rejected', () => {
    const root = parseError(`${READY}[polcy]\nstallRounds = 3\n`)
    expect(root.message).toContain('"polcy"')
    expect(root.message).toContain('known top-level keys: baseBranch, capacity')
    expect(root.message).toContain('known tables: pr, commands')

    expect(parseError(`${READY}[policy]\nstallRound = 3\n`).message).toContain('"stallRound"')
    expect(parseError(`${READY}[roles.default]\nmdel = "x"\n`).message).toContain('"mdel"')
    expect(parseError(`${READY}[verify]\nfoo = "bar"\n`).message).toContain('verify.foo')
  })

  test('removed tables are ordinary unknown top-level keys with no aliases', () => {
    for (const [table, body] of [
      ['project', 'baseBranch = "trunk"'],
      ['dispatcher', 'capacity = 2'],
      ['harvest', 'threshold = 2'],
      ['outer', '"ingest:sentry" = { cron = "0 * * * *" }'],
    ]) {
      const error = parseError(`${READY}[${table}]\n${body}\n`)
      expect(error.message).toContain(`"${table}"`)
      expect(error.message).toContain('known top-level keys')
    }
  })

  test('legacy [agent] retains its focused replacement hint', () => {
    const error = parseError(`${READY}[agent]\nruntime = "pi"\n`)
    expect(error.message).toContain('[agent] was removed')
    expect(error.message).toContain('[roles.default]')
  })
})

describe('parseConfig — TOML syntax errors', () => {
  test('surface with the source name', () => {
    expect(parseError('[unclosed\n', 'repo/autobuild.toml').message).toContain('repo/autobuild.toml: TOML syntax error')
  })
})

describe('loadConfig', () => {
  test('reads flattened values from disk and reports bad paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-config-test-'))
    try {
      const good = join(dir, 'autobuild.toml')
      await writeFile(good, `baseBranch = "trunk"\ncapacity = 2\n${READY}`)
      const config = await loadConfig(good)
      expect(config.baseBranch).toBe('trunk')
      expect(config.capacity).toBe(2)

      const bad = join(dir, 'bad.toml')
      await writeFile(bad, '[polcy]\n')
      await expect(loadConfig(bad)).rejects.toThrow('bad.toml')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
