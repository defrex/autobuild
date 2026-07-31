import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig, parseConfig } from './load'

const READY = '[tickets]\nsource = "file"\nreadyState = "ready"\n'

const COMPLETE_EXAMPLE = `baseBranch = "main"
capacity = 3
forge = "gitlab"
plugins = ["./plugins/local.ts", "@acme/autobuild-plugin"]

[workspace]
provider = "container"

[workspace.config]
image = "bun:latest"
writable = true

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
maxSetupAttempts = 3
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
      forge: 'gitlab',
      plugins: ['./plugins/local.ts', '@acme/autobuild-plugin'],
      workspace: {
        provider: 'container',
        config: { image: 'bun:latest', writable: true },
      },
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
      verify: {
        steps: ['types', 'unit', 'e2e'],
        stepConfigs: {
          types: { kind: 'check', command: 'typecheck' },
          unit: { kind: 'check', command: 'test' },
          e2e: {
            kind: 'agent',
            skill: 'ab-verify-e2e',
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
        maxSetupAttempts: 3,
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
      forge: 'github',
      plugins: [],
      workspace: { provider: 'git-worktree', config: {} },
      commands: {},
      verify: { steps: [], stepConfigs: {} },
      finalize: { steps: [], stepConfigs: {} },
      roles: {},
      policy: {
        stallRounds: 3,
        maxVerifyAttempts: 3,
        maxSetupAttempts: 3,
        maxReconcileAttempts: 3,
        maxReviewRounds: 6,
        harvestThreshold: 5,
      },
      tickets: { source: 'file', readyState: 'ready' },
    })
  })

  test('workspace defaults to git-worktree and preserves plugin-owned nested config', () => {
    expect(parseConfig(READY).workspace).toEqual({
      provider: 'git-worktree',
      config: {},
    })
    expect(
      parseConfig(
        `[workspace]\nprovider = "container"\n[workspace.config]\nimage = "bun:latest"\nlimits = { cpu = 2 }\n${READY}`,
      ).workspace,
    ).toEqual({
      provider: 'container',
      config: { image: 'bun:latest', limits: { cpu: 2 } },
    })
  })

  test('workspace envelope is strict and the configless builtin rejects adapter config', () => {
    expect(() => parseConfig(`[workspace]\nprovider = "   "\n${READY}`)).toThrow(
      /workspace\.provider/,
    )
    expect(() =>
      parseConfig(`[workspace]\nprovider = "git-worktree"\nextra = true\n${READY}`),
    ).toThrow(/workspace:.*extra/)
    expect(() => parseConfig(`[workspace.config]\nroot = "elsewhere"\n${READY}`)).toThrow(
      /workspace\.config/,
    )
  })

  // `[workspace.config]` is a plugin-owned pass-through: Autobuild does not
  // interpret these keys, so losing one is undetectable downstream. Everything
  // below drives `parseConfig` rather than a hand-built config object, because
  // a directly constructed map bypasses the exact step that used to lose the
  // entry.
  const pluginWorkspace = (table: string) =>
    parseConfig(`[workspace]\nprovider = "container"\n[workspace.config]\n${table}${READY}`)
      .workspace.config

  for (const key of ['__proto__', 'constructor', 'toString']) {
    test(`a [workspace.config] key named "${key}" reaches the provider intact`, () => {
      const config = pluginWorkspace(`"${key}" = "kept"\nimage = "bun:latest"\n`)
      expect(Object.keys(config)).toContain(key)
      expect(Object.getOwnPropertyDescriptor(config, key)?.value).toBe('kept')
      // The ordinary key alongside it is untouched.
      expect(config.image).toBe('bun:latest')
    })
  }

  test('a parsed workspace config never answers with an inherited member', () => {
    const declared = pluginWorkspace('image = "bun:latest"\n')
    expect(Object.getPrototypeOf(declared)).toBeNull()
    expect(declared.toString).toBeUndefined()
    expect(declared.constructor).toBeUndefined()
    // Including when the table is absent entirely — `prefault` runs the
    // transform, where `default` would hand back a plain `{}`.
    expect(Object.getPrototypeOf(parseConfig(READY).workspace.config)).toBeNull()
  })

  test('a blank [workspace.config] key is plugin-addressable, not an error', () => {
    // Autobuild does not interpret these keys, so it is not Autobuild's place
    // to narrow what a plugin may declare. This is the assertion that fails if
    // this map's `keys: 'any'` policy is ever "tidied" back to the default.
    const config = pluginWorkspace('"" = "addressable"\n')
    expect(config['']).toBe('addressable')
  })

  test('[commands] and [roles] still reject a blank entry name', () => {
    // The new axis is per-map, not a global relaxation: these two name things
    // Autobuild itself must address.
    expect(() => parseConfig(`[commands]\n"" = "echo hi"\n${READY}`)).toThrow(/commands/)
    expect(() => parseConfig(`[roles.""]\nruntime = "claude"\n${READY}`)).toThrow(/roles/)
  })

  test('git-worktree still rejects a [workspace.config] holding only a hazardous key', () => {
    // The regression that matters most: these tables used to parse to an empty
    // map, so the unsupported-table diagnostic never fired. Match the
    // diagnostic itself, not just its path — a blank-key rejection would be
    // reported under `workspace.config` too, and must not pass for it.
    const unsupported = /is not supported by the builtin "git-worktree" provider/
    for (const table of ['"__proto__" = "kept"', '"" = "addressable"']) {
      expect(() => parseConfig(`[workspace.config]\n${table}\n${READY}`)).toThrow(unsupported)
      expect(() =>
        parseConfig(
          `[workspace]\nprovider = "git-worktree"\n[workspace.config]\n${table}\n${READY}`,
        ),
      ).toThrow(unsupported)
    }
  })

  test('an absent or genuinely empty [workspace.config] draws no git-worktree diagnostic', () => {
    for (const source of [
      READY,
      `[workspace]\nprovider = "git-worktree"\n${READY}`,
      `[workspace.config]\n${READY}`,
    ]) {
      expect(Object.keys(parseConfig(source).workspace.config)).toHaveLength(0)
    }
  })

  test('forge defaults to GitHub and accepts nonblank plugin adapter names', () => {
    expect(parseConfig(READY).forge).toBe('github')
    expect(parseConfig(`forge = "gitlab"\n${READY}`).forge).toBe('gitlab')
    for (const value of ['""', '"   "', '1']) {
      expect(() => parseConfig(`forge = ${value}\n${READY}`)).toThrow(/forge/)
    }
  })

  test('plugins default empty and accept repository paths and package specifiers', () => {
    expect(parseConfig(READY).plugins).toEqual([])
    expect(
      parseConfig(`plugins = ["./plugins/local.ts", "@acme/autobuild-plugin"]\n${READY}`).plugins,
    ).toEqual(['./plugins/local.ts', '@acme/autobuild-plugin'])
    for (const value of ['[""]', '["   "]', '[1]']) {
      expect(() => parseConfig(`plugins = ${value}\n${READY}`)).toThrow(/plugins/)
    }
  })

  test('rejects every later occurrence of an exact duplicate plugin specifier', () => {
    const pathError = parseError(
      `plugins = ["./plugins/local.ts", "@acme/autobuild-plugin", "./plugins/local.ts"]\n${READY}`,
    )
    expect(pathError.message).toContain(
      'plugins[2]: duplicate plugin module specifier "./plugins/local.ts"',
    )
    expect(pathError.message).toContain(
      'first declared at plugins[0]; remove or deduplicate this entry',
    )

    const packageError = parseError(
      `plugins = ["@acme/autobuild-plugin", "./plugins/local.ts", "@acme/autobuild-plugin", "@acme/autobuild-plugin"]\n${READY}`,
    )
    expect(packageError.message).toContain(
      'plugins[2]: duplicate plugin module specifier "@acme/autobuild-plugin"',
    )
    expect(packageError.message).toContain(
      'plugins[3]: duplicate plugin module specifier "@acme/autobuild-plugin"',
    )
    expect(packageError.message).toContain(
      'first declared at plugins[0]; remove or deduplicate this entry',
    )
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
      expect(() => parseConfig(`${READY}[policy]\nharvestThreshold = ${value}\n`)).toThrow(
        /policy\.harvestThreshold/,
      )
    }
  })

  test('agent verification needs only its skill', () => {
    const config = parseConfig(`${READY}
[verify]
steps = ["e2e"]
[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
`)
    expect(config.verify.stepConfigs.e2e).toEqual({
      kind: 'agent',
      skill: 'ab-verify-e2e',
    })
  })

  test('partial [policy] keeps every other per-key default', () => {
    expect(parseConfig(`${READY}[policy]\nstallRounds = 7\n`).policy).toEqual({
      stallRounds: 7,
      maxVerifyAttempts: 3,
      maxSetupAttempts: 3,
      maxReconcileAttempts: 3,
      maxReviewRounds: 6,
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
    expect(() =>
      parseConfig(`${READY}[pr.imageHost]\nprovider = "s3"\nrepository = "a/b"\nreleaseId = 1\n`),
    ).toThrow(/pr\.imageHost/)
    expect(() =>
      parseConfig(
        `${READY}[pr.imageHost]\nprovider = "github-release"\nrepository = "bad"\nreleaseId = 1\n`,
      ),
    ).toThrow(/pr\.imageHost\.repository/)
    expect(() =>
      parseConfig(
        `${READY}[pr.imageHost]\nprovider = "github-release"\nrepository = "a/b"\nreleaseId = 0\n`,
      ),
    ).toThrow(/pr\.imageHost\.releaseId/)
    expect(() => parseConfig(`${READY}[pr]\nunknown = true\n`)).toThrow(/pr/)
  })

  test('rejects the removed dashboardFrames table', () => {
    expect(() =>
      parseConfig(
        `${READY}[dashboardFrames]\nprovider = "github-release"\nrepository = "a/b"\nreleaseId = 1\n`,
      ),
    ).toThrow(/dashboardFrames/)
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

    const orphan = parseError(
      `${READY}[commands]\ntypecheck = "tsc"\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n`,
    )
    expect(orphan.message).toContain('verify.types')
    expect(orphan.message).toContain('not listed')

    const command = parseError(
      `${READY}[verify]\nsteps = ["types"]\n[verify.types]\nkind = "check"\ncommand = "typecheck"\n`,
    )
    expect(command.message).toContain('verify.types.command')
    expect(command.message).toContain('[commands] has no entries')
  })

  test('removed server configuration fails with focused guidance', () => {
    const server = parseError(`${READY}[server]\nstart = "bun dev"\nurl = "http://localhost"\n`)
    expect(server.message).toContain('[server] was removed')

    for (const value of ['true', 'false']) {
      const needsServer = parseError(
        `${READY}[verify]\nsteps = ["e2e"]\n[verify.e2e]\nkind = "agent"\nskill = "ab-verify-e2e"\nneedsServer = ${value}\n`,
      )
      expect(needsServer.message).toContain('verify.e2e')
      expect(needsServer.message).toContain('needsServer was removed')
    }

    const mixed = parseError(
      `${READY}[verify]\nsteps = ["e2e"]\n[verify.e2e]\nkind = "agent"\nskill = "ab-verify-e2e"\nneedsServer = true\nbogus = 1\n`,
    )
    expect(mixed.message).toContain('verify.e2e.needsServer')
    expect(mixed.message).toContain('needsServer was removed')
    expect(mixed.message).toContain('"bogus"')
  })
})

describe('parseConfig — what an operator sees for a malformed step table', () => {
  test('the whole error block, verbatim', () => {
    const error = parseError(`${READY}[commands]
test = "bun test"

[verify]
steps = ["unit", "e2e"]

[verify.unit]
kind = "check"
command = "test"
bogus = 1

[verify.e2e]
kind = "browser"
skill = "ab-verify-e2e"
`)

    // Every line an operator gets, in order. The second is the tagged-choice
    // message: [verify.<step>] is a discriminated union, which names the tags it
    // expected and so has no branch detail to expand.
    expect(error.message).toBe(
      [
        'autobuild.toml: invalid config',
        '  verify.unit: Unrecognized key: "bogus"',
        "  verify.e2e.kind: Invalid discriminator value. Expected 'check' | 'agent'",
      ].join('\n'),
    )

    // And the structured payload keeps what validation reported, rather than the
    // `custom` re-encoding the entry boundary used to apply on the way out.
    expect(error.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['bogus'],
        path: ['verify', 'unit'],
      }),
      expect.objectContaining({ code: 'invalid_union', path: ['verify', 'e2e', 'kind'] }),
    ])
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

    const orphan = parseError(
      `${READY}[commands]\npublish = "bun publish"\n[finalize.publish]\nkind = "check"\ncommand = "publish"\n`,
    )
    expect(orphan.message).toContain('finalize.publish')
    expect(orphan.message).toContain('not listed')

    const command = parseError(
      `${READY}[finalize]\nsteps = ["publish"]\n[finalize.publish]\nkind = "check"\ncommand = "missing"\n`,
    )
    expect(command.message).toContain('finalize.publish.command')
    expect(command.message).toContain('does not name a key in [commands]')
  })

  test('removed needsServer guidance does not mislabel a finalize step', () => {
    const error = parseError(`${READY}
[finalize]
steps = ["notes"]
[finalize.notes]
kind = "agent"
skill = "ab-notes"
needsServer = true
`)
    expect(error.message).toContain('finalize.notes.needsServer')
    expect(error.message).toContain("inside this step's command or skill")
    expect(error.message).not.toContain("this verify step's")
  })

  test('rejects empty entries, malformed kinds, unknown fields, and verify-only fields', () => {
    expect(parseError(`${READY}[finalize]\nsteps = ["notes", ""]\n`).message).toContain(
      'finalize.steps[1]',
    )

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
    expect(
      parseConfig('[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\n').tickets,
    ).toEqual({
      source: 'linear',
      teamKey: 'ENG',
      readyState: 'Todo',
    })
  })

  test('plugin source names parse while source and readyState remain nonblank', () => {
    expect(
      parseConfig(
        '[tickets]\nsource = "jira-cloud"\nreadyState = "Open"\nteamKey = "APP"\nclaimedState = "Doing"\ndir = "plugin-option"\n',
      ).tickets,
    ).toEqual({
      source: 'jira-cloud',
      readyState: 'Open',
      teamKey: 'APP',
      claimedState: 'Doing',
      dir: 'plugin-option',
    })
    expect(parseError('[tickets]\nsource = "   "\nreadyState = "Open"\n').message).toContain(
      'tickets.source',
    )
    expect(parseError('[tickets]\nsource = "file"\n').message).toContain('tickets.readyState')
    expect(parseError('[tickets]\nsource = "file"\nreadyState = "   "\n').message).toContain(
      'must not be blank',
    )
  })

  test('source-specific fields are cross-validated', () => {
    expect(parseError('[tickets]\nsource = "linear"\nreadyState = "Todo"\n').message).toContain(
      'tickets.teamKey',
    )
    expect(
      parseError(
        '[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Todo"\ndir = "tickets"\n',
      ).message,
    ).toContain('tickets.dir')
    const file = parseError(
      '[tickets]\nsource = "file"\nreadyState = "ready"\nteamKey = "ENG"\nclaimedState = "Doing"\n',
    )
    expect(file.message).toContain('tickets.teamKey')
    expect(file.message).toContain('tickets.claimedState')
  })

  test('readiness labels and lifecycle states retain their surface', () => {
    const config = parseConfig(
      '[tickets]\nsource = "file"\nreadyState = "ready"\nreadyLabels = []\ncreateState = "Triage"\ntriageState = "Triage"\nproposalState = "ready"\ndir = "tickets"\n',
    )
    expect(config.tickets).toEqual({
      source: 'file',
      readyState: 'ready',
      readyLabels: [],
      createState: 'Triage',
      triageState: 'Triage',
      proposalState: 'ready',
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
    expect(root.message).toContain('known tables: pr, workspace, commands')

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
    expect(parseError('[unclosed\n', 'repo/autobuild.toml').message).toContain(
      'repo/autobuild.toml: TOML syntax error',
    )
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
