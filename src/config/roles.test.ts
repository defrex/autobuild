/**
 * Role-key consumability (SPEC §9). Pure over a parsed config, so every AC
 * about what the operator is told is assertable without a dispatcher.
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from './load'
import { INTERNAL_ROLES, roleKeyDiagnostics, roleKeyWarnings } from './roles'

const TICKETS = '[tickets]\nsource = "file"\nreadyState = "ready"\n'

/** A config whose `[roles]` table is whatever the case under test needs. */
function config(body: string) {
  return parseConfig(`${TICKETS}\n${body}`, 'autobuild.toml')
}

const DEFAULT_ROLE = '[roles.default]\nruntime = "claude"\n'

/** A one-agent-verify-step config, with `[roles]` supplied per case. */
function withVerify(steps: string, roles: string) {
  return config(`[commands]\ncheck = "true"\n\n${steps}\n${DEFAULT_ROLE}${roles}`)
}

const E2E_STEP = `[verify]
steps = ["e2e"]

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
`

describe('roleKeyDiagnostics — unconsumed keys', () => {
  test('every unconsumed key is reported, sorted, and never just the first', () => {
    const d = roleKeyDiagnostics(
      config(
        `${DEFAULT_ROLE}[roles.typo]\nruntime = "claude"\n\n[roles.ghost]\nruntime = "claude"\n`,
      ),
    )
    expect(d.unconsumed).toEqual(['ghost', 'typo'])
    expect(d.deprecated).toEqual([])
  })

  test('the reserved `default` key is never reported as unconsumed', () => {
    const d = roleKeyDiagnostics(config(DEFAULT_ROLE))
    expect(d.unconsumed).toEqual([])
    expect(roleKeyWarnings(config(DEFAULT_ROLE))).toEqual([])
  })

  test('all six core phases and all four internal roles are consumable', () => {
    const keys = [
      'plan',
      'plan-review',
      'implement',
      'code-review',
      'finalize',
      'reconcile',
      ...INTERNAL_ROLES,
    ]
    const roles = keys.map((key) => `[roles.${key}]\nruntime = "claude"\n`).join('\n')
    const parsed = config(`${DEFAULT_ROLE}${roles}`)
    expect(roleKeyDiagnostics(parsed).unconsumed).toEqual([])
    expect(roleKeyWarnings(parsed)).toEqual([])
    for (const key of ['default', ...keys]) {
      expect(roleKeyDiagnostics(parsed).valid).toContain(key)
    }
  })

  test('a key reachable only through a check verify or finalize step is unconsumed', () => {
    // A check starts no session and consumes no role, so naming one after a
    // check step is exactly the mistake this warning exists to catch.
    const parsed = config(
      `[commands]\ncheck = "true"\n\n` +
        `[verify]\nsteps = ["lint"]\n\n[verify.lint]\nkind = "check"\ncommand = "check"\n\n` +
        `[finalize]\nsteps = ["tag"]\n\n[finalize.tag]\nkind = "check"\ncommand = "check"\n\n` +
        `${DEFAULT_ROLE}[roles.lint]\nruntime = "claude"\n\n[roles.tag]\nruntime = "claude"\n`,
    )
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual(['lint', 'tag'])
    expect(d.valid).not.toContain('lint')
    expect(d.valid).not.toContain('tag')
  })

  test('…but a check step NAME can still be consumed by another route', () => {
    // A check step is not a route; it is not an anti-route either. A check step
    // named `plan` leaves [roles.plan] consumed by the core plan phase, so
    // "a role named after a check step is unconsumed" is only true when that
    // check is the key's ONLY apparent route. Both docs say so; this pins it.
    const parsed = config(
      `[commands]\ncheck = "true"\n\n` +
        `[verify]\nsteps = ["plan"]\n\n[verify.plan]\nkind = "check"\ncommand = "check"\n\n` +
        `${DEFAULT_ROLE}[roles.plan]\nruntime = "claude"\n`,
    )
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual([])
    expect(d.valid).toContain('plan')
    expect(roleKeyWarnings(parsed)).toEqual([])
  })

  test('an agent verify step name and an agent finalize step name are both consumable', () => {
    const parsed = config(
      `${E2E_STEP}\n` +
        `[finalize]\nsteps = ["release-notes"]\n\n` +
        `[finalize.release-notes]\nkind = "agent"\nskill = "ab-release-notes"\n\n` +
        `${DEFAULT_ROLE}[roles.e2e]\nruntime = "claude"\n\n[roles.release-notes]\nruntime = "claude"\n`,
    )
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual([])
    expect(d.valid).toContain('e2e')
    expect(d.valid).toContain('release-notes')
  })

  test('a clean configuration warns about nothing at all', () => {
    expect(roleKeyWarnings(withVerify(E2E_STEP, '[roles.e2e]\nruntime = "claude"\n'))).toEqual([])
  })
})

describe('roleKeyDiagnostics — the deprecated skill-name alias', () => {
  test('safe rename: one step, no other consumer', () => {
    const parsed = withVerify(E2E_STEP, '[roles.ab-verify-e2e]\nruntime = "claude"\n')
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual([])
    expect(d.deprecated).toEqual([
      { key: 'ab-verify-e2e', activeAlias: ['e2e'], supersededAlias: [] },
    ])
    expect(roleKeyWarnings(parsed)).toEqual([
      'autobuild.toml: [roles.ab-verify-e2e] should be [roles.e2e] — it is the deprecated ' +
        'skill-name key for agent verify step "e2e" and stops working in a future release.',
    ])
  })

  test('inert alias: the step declares its own role, so the key can be deleted', () => {
    const parsed = withVerify(
      E2E_STEP,
      '[roles.e2e]\nruntime = "claude"\n\n[roles.ab-verify-e2e]\nruntime = "claude"\n',
    )
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual([])
    expect(d.deprecated).toEqual([
      { key: 'ab-verify-e2e', activeAlias: [], supersededAlias: ['e2e'] },
    ])
    const [notice, ...rest] = roleKeyWarnings(parsed)
    expect(rest).toEqual([])
    expect(notice).toBe(
      'autobuild.toml: [roles.ab-verify-e2e] can be deleted — agent verify step "e2e" ' +
        'declares its own step-named role, so this deprecated skill-name key changes nothing.',
    )
  })

  test('a shared skill whose other step is superseded is a plain rename that CONVERGES', () => {
    // A superseded alias is inert by definition, so it is not a reason to keep
    // the key. Calling it one produced advice that did not converge: "keep it,
    // it is also the superseded key for e2e", then "it can be deleted" on the
    // very next dispatch.
    const shared = `[verify]
steps = ["e2e", "visual"]

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"

[verify.visual]
kind = "agent"
skill = "ab-verify-e2e"
`
    const parsed = withVerify(
      shared,
      '[roles.e2e]\nruntime = "claude"\n\n[roles.ab-verify-e2e]\nruntime = "pi"\n',
    )
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual([])
    // The superseded step is still REPORTED — it is a real fact about the key.
    expect(d.deprecated).toEqual([
      { key: 'ab-verify-e2e', activeAlias: ['visual'], supersededAlias: ['e2e'] },
    ])
    const [notice, ...rest] = roleKeyWarnings(parsed)
    expect(rest).toEqual([])
    expect(notice).toBe(
      'autobuild.toml: [roles.ab-verify-e2e] should be [roles.visual] — it is the deprecated ' +
        'skill-name key for agent verify step "visual" and stops working in a future release.',
    )
    // It never says to keep the key for a step that does not use it.
    expect(notice).not.toContain('Keep [roles.ab-verify-e2e]')
    expect(notice).not.toContain('superseded')

    // Follow it LITERALLY — rename the key — and the config goes silent. One
    // edit, not a two-step dance ending in a delete.
    const migrated = withVerify(
      shared,
      '[roles.e2e]\nruntime = "claude"\n\n[roles.visual]\nruntime = "pi"\n',
    )
    expect(roleKeyWarnings(migrated)).toEqual([])
  })

  test('two steps and nothing else: declare both, then delete', () => {
    const parsed = withVerify(
      `[verify]
steps = ["e2e", "visual"]

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"

[verify.visual]
kind = "agent"
skill = "ab-verify-e2e"
`,
      '[roles.ab-verify-e2e]\nruntime = "claude"\n',
    )
    const [notice] = roleKeyWarnings(parsed)
    expect(notice).toContain('[roles.ab-verify-e2e] should be [roles.e2e] and [roles.visual]')
    expect(notice).toContain('Delete [roles.ab-verify-e2e] once those are declared.')
  })

  test('a canonical collision reports the core-phase use and never advises rename or delete', () => {
    const parsed = withVerify(
      `[verify]
steps = ["e2e"]

[verify.e2e]
kind = "agent"
skill = "plan"
`,
      '[roles.plan]\nruntime = "claude"\n',
    )
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual([])
    expect(d.deprecated).toEqual([
      {
        key: 'plan',
        canonicalUse: 'the "plan" core phase role',
        activeAlias: ['e2e'],
        supersededAlias: [],
      },
    ])
    const [notice] = roleKeyWarnings(parsed)
    expect(notice).toContain('[roles.plan] should be [roles.e2e]')
    expect(notice).toContain('Keep [roles.plan]: it is also the "plan" core phase role.')
    expect(notice).not.toContain('Delete')
    expect(notice).not.toContain('can be deleted')
  })

  test('a self-named skill produces no notice at all', () => {
    const parsed = withVerify(
      `[verify]
steps = ["e2e"]

[verify.e2e]
kind = "agent"
skill = "e2e"
`,
      '[roles.e2e]\nruntime = "claude"\n',
    )
    expect(roleKeyWarnings(parsed)).toEqual([])
    expect(roleKeyDiagnostics(parsed).deprecated).toEqual([])
  })
})

describe('roleKeyWarnings — one notice is always ONE line', () => {
  // A notice goes to stderr verbatim, one per line, and the dashboard wraps it
  // into rows it controls. A raw control character in a user-chosen name breaks
  // both: stderr silently gains a physical line, so what is one diagnostic
  // becomes two. Escaping the table header is not enough — the PROSE phrases
  // carry names too, and `canonicalUse` builds one of them outside the notice
  // renderer entirely.
  const HOSTILE = ['odd\nname', 'quote"d', 'tab\there', 'carriage\rreturn', 'ui.visual']

  const roleFor = (key: string) => `[roles.${JSON.stringify(key)}]\nruntime = "claude"\n`
  const agentStep = (step: string, skill: string) =>
    `[verify.${JSON.stringify(step)}]\nkind = "agent"\nskill = ${JSON.stringify(skill)}\n`

  /** The same odd name driven through every branch of the notice renderer. */
  function branches(name: string) {
    return {
      unconsumed: config(`${DEFAULT_ROLE}${roleFor(name)}`),
      safeRename: config(
        `[verify]\nsteps = [${JSON.stringify(name)}]\n${agentStep(name, 'legacy')}` +
          `${DEFAULT_ROLE}${roleFor('legacy')}`,
      ),
      inert: config(
        `[verify]\nsteps = [${JSON.stringify(name)}]\n${agentStep(name, 'legacy')}` +
          `${DEFAULT_ROLE}${roleFor(name)}${roleFor('legacy')}`,
      ),
      // The finding's case: the declared legacy key is ALSO a canonical step
      // name, so the shared/colliding branch appends the `canonicalUse` phrase.
      canonicalCollision: config(
        `[verify]\nsteps = [${JSON.stringify(name)}, "visual"]\n` +
          `${agentStep(name, 'other-skill')}${agentStep('visual', name)}` +
          `${DEFAULT_ROLE}${roleFor(name)}`,
      ),
    }
  }

  for (const name of HOSTILE) {
    test(`no notice for a name like ${JSON.stringify(name)} carries a raw control character`, () => {
      for (const parsed of Object.values(branches(name))) {
        const lines = roleKeyWarnings(parsed)
        expect(lines.length).toBeGreaterThan(0)
        for (const line of lines) {
          expect(line).not.toMatch(/[\u0000-\u001f\u007f]/)
          expect(line.split('\n')).toHaveLength(1)
        }
      }
    })
  }

  test('a canonical collision escapes the step name in its "Keep" clause', () => {
    // Pinned explicitly: this phrase is built in `roleKeyDiagnostics`, not in
    // the notice renderer, and was the one path header escaping never reached.
    const [notice, ...rest] = roleKeyWarnings(branches('odd\nname').canonicalCollision)
    expect(rest).toEqual([])
    expect(notice).toBe(
      'autobuild.toml: [roles."odd\\nname"] should be [roles.visual] — it routes that agent ' +
        'verify step through the deprecated skill-name key. Keep [roles."odd\\nname"]: it is ' +
        'also agent verify step "odd\\nname".',
    )
  })

  test('a quote in a step name cannot break out of its prose phrase', () => {
    const [notice] = roleKeyWarnings(branches('quote"d').canonicalCollision)
    expect(notice).toContain('agent verify step "quote\\"d"')
    // The escaped phrase round-trips back to the real name.
    expect(JSON.parse(notice!.slice(notice!.lastIndexOf('step ') + 5, -1))).toBe('quote"d')
  })

  test('ordinary names are untouched — escaping is need-only', () => {
    const [notice] = roleKeyWarnings(
      withVerify(E2E_STEP, '[roles.ab-verify-e2e]\nruntime = "claude"\n'),
    )
    expect(notice).toContain('agent verify step "e2e"')
    expect(notice).not.toContain('\\')
  })
})

describe('roleKeyWarnings — every emitted key is TOML the operator can paste', () => {
  /** Every `[roles.<key>]` a notice tells the operator to write. */
  function emittedTables(lines: readonly string[]): string[] {
    return lines.flatMap((line) =>
      [...line.matchAll(/\[roles\.(?:"(?:[^"\\]|\\.)*"|[^\]]*)\]/g)].map((m) => m[0]),
    )
  }

  // Role and step names are arbitrary nonempty strings. A bare interpolation is
  // wrong two different ways: `[roles.ab verify]` is a syntax error, and
  // `[roles.ui.visual]` is not the key at all — TOML reads the dot as nesting
  // and rejects `visual` as an unknown field under `roles.ui`.
  const AWKWARD = ['ui.visual', 'ab verify', 'e2e#1', 'smoke:fast', 'quote"d']

  for (const name of AWKWARD) {
    test(`a step named ${JSON.stringify(name)} yields a replacement that PARSES`, () => {
      const parsed = withVerify(
        `[verify]
steps = [${JSON.stringify(name)}]

[verify.${JSON.stringify(name)}]
kind = "agent"
skill = "legacy-skill"
`,
        '[roles.legacy-skill]\nruntime = "claude"\n',
      )
      const tables = emittedTables(roleKeyWarnings(parsed))
      expect(tables).toContain('[roles.legacy-skill]')

      // Apply each emitted header verbatim. A header that is not valid TOML
      // throws; one that silently NESTS (`[roles.ui.visual]`) declares the
      // wrong key or is rejected as an unknown field. Both are what an operator
      // following the advice would hit.
      const declaredBy = (table: string): string[] => {
        const applied = parseConfig(`${TICKETS}\n${DEFAULT_ROLE}${table}\nruntime = "claude"\n`)
        return Object.keys(applied.roles).filter((key) => key !== 'default')
      }
      for (const table of tables) expect(declaredBy(table)).toHaveLength(1)

      // …and the replacement it names really is the step's own literal key.
      const replacement = tables.find((table) => table !== '[roles.legacy-skill]')
      expect(replacement).toBeDefined()
      expect(declaredBy(replacement!)).toEqual([name])
    })

    test(`an unconsumed [roles] key named ${JSON.stringify(name)} is reported quotably`, () => {
      const parsed = config(`${DEFAULT_ROLE}[roles.${JSON.stringify(name)}]\nruntime = "claude"\n`)
      const [stray, validList] = roleKeyWarnings(parsed)
      for (const table of emittedTables([stray!])) {
        expect(() =>
          parseConfig(`${TICKETS}\n${DEFAULT_ROLE}${table}\nruntime = "claude"\n`),
        ).not.toThrow()
      }
      // The valid-key list is what the operator types next, so it carries the
      // same quoting rather than a bare name that would not parse.
      expect(validList).toContain('Valid role keys:')
    })
  }

  test('a valid key needing quotes is listed quoted, and ordinary keys are untouched', () => {
    const parsed = withVerify(
      `[verify]
steps = ["ui.visual"]

[verify."ui.visual"]
kind = "agent"
skill = "ab-verify-ui"
`,
      '[roles.ghost]\nruntime = "claude"\n',
    )
    const [, validList] = roleKeyWarnings(parsed)
    expect(validList).toContain('"ui.visual"')
    // Bare-key names stay bare — no churn for an ordinary configuration.
    expect(validList).toContain('code-review')
    expect(validList).not.toContain('"code-review"')
  })
})

describe('roleKeyDiagnostics — prototype-colliding step names', () => {
  // Step names are an open set, so `constructor` and friends are legal. Reading
  // the step table off a normal object answers an inherited FUNCTION, which
  // fails the `kind` test and silently drops the step from the consumable set.
  // The diagnostic would then contradict the role the resolver really routes it
  // on — the pairing this whole change exists to keep honest.
  for (const step of ['constructor', 'toString', 'valueOf']) {
    const STEP_TOML = `[verify]
steps = ["${step}"]

[verify.${step}]
kind = "agent"
skill = "ab-verify-thing"
`

    test(`an agent verify step named "${step}" is consumable, not unconsumed`, () => {
      const parsed = withVerify(STEP_TOML, `[roles."${step}"]\nruntime = "claude"\n`)
      const d = roleKeyDiagnostics(parsed)
      expect(d.unconsumed).toEqual([])
      expect(d.valid).toContain(step)
      expect(roleKeyWarnings(parsed)).toEqual([])
    })

    test(`…and its deprecated skill-name key is reported against "${step}"`, () => {
      const parsed = withVerify(STEP_TOML, '[roles.ab-verify-thing]\nruntime = "claude"\n')
      expect(roleKeyDiagnostics(parsed).deprecated).toEqual([
        { key: 'ab-verify-thing', activeAlias: [step], supersededAlias: [] },
      ])
      expect(roleKeyWarnings(parsed)[0]).toContain(
        `[roles.ab-verify-thing] should be [roles.${step}]`,
      )
    })
  }

  // `__proto__` is the sharpest of these: it is a legal TOML key, but assigning
  // it into a normal object invokes the legacy prototype setter instead of
  // creating an own key. Everything below therefore goes through `parseConfig`,
  // not a hand-built roles object — a directly constructed map would bypass the
  // exact step that used to lose the entry.
  for (const key of ['__proto__', 'constructor', 'toString']) {
    test(`a declared but unconsumed [roles."${key}"] survives parseConfig and is reported`, () => {
      const parsed = config(`${DEFAULT_ROLE}[roles."${key}"]\nruntime = "claude"\n`)
      expect(Object.keys(parsed.roles)).toContain(key)
      expect(Object.hasOwn(parsed.roles, key)).toBe(true)
      expect(roleKeyDiagnostics(parsed).unconsumed).toEqual([key])
      expect(roleKeyWarnings(parsed)[0]).toContain(`[roles.${key}]`)
    })

    test(`a CONSUMED [roles."${key}"] parses, is silent, and keeps its own fields`, () => {
      const parsed = withVerify(
        `[verify]
steps = ["${key}"]

[verify."${key}"]
kind = "agent"
skill = "ab-verify-thing"
`,
        `[roles."${key}"]\nruntime = "pi"\nmodel = "kimi-coding/k3"\n`,
      )
      // The entry is a real role table, not a mangled prototype.
      expect(parsed.roles[key]).toEqual({ runtime: 'pi', model: 'kimi-coding/k3' })
      expect(roleKeyWarnings(parsed)).toEqual([])
      expect(roleKeyDiagnostics(parsed).valid).toContain(key)
    })
  }

  test('an open map never leaks its entries onto the prototype chain', () => {
    const parsed = config(
      `${DEFAULT_ROLE}[roles."__proto__"]\nruntime = "pi"\nmodel = "kimi-coding/k3"\n\n` +
        `[commands]\n"__proto__" = "echo hi"\n`,
    )
    // The setter would have made `roles.runtime` readable through inheritance
    // while `Object.keys` showed nothing.
    expect(Object.getPrototypeOf(parsed.roles)).toBeNull()
    expect(Object.getPrototypeOf(parsed.commands)).toBeNull()
    expect((parsed.roles as Record<string, unknown>).runtime).toBeUndefined()
    // By descriptor: an OWN entry is the claim, and it is what the setter ate.
    expect(Object.getOwnPropertyDescriptor(parsed.commands, '__proto__')?.value).toBe('echo hi')
  })

  test('a check step named `constructor` is still not consumable', () => {
    // The own-property fix must not accidentally make every named table count:
    // a check starts no session whatever it is called.
    const parsed = withVerify(
      `[verify]
steps = ["constructor"]

[verify.constructor]
kind = "check"
command = "check"
`,
      '[roles.constructor]\nruntime = "claude"\n',
    )
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual(['constructor'])
    expect(d.valid).not.toContain('constructor')
  })
})

describe('roleKeyDiagnostics — the reserved key', () => {
  const RESERVED_SKILL = `[verify]
steps = ["e2e"]

[verify.e2e]
kind = "agent"
skill = "default"
`

  test('`skill = "default"` makes [roles.default] the step\'s ACTIVE alias', () => {
    // The resolver matches `default` by name at its own position in the walk,
    // so this step really does run on [roles.default] — the deprecation notice
    // is required, and rename/delete advice must stay unreachable.
    const parsed = withVerify(RESERVED_SKILL, '')
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual([])
    expect(d.deprecated).toEqual([
      {
        key: 'default',
        canonicalUse: 'the reserved [roles.default] inheritance base',
        activeAlias: ['e2e'],
        supersededAlias: [],
      },
    ])
    const [notice] = roleKeyWarnings(parsed)
    expect(notice).toContain('[roles.default] should be [roles.e2e]')
    expect(notice).toContain(
      'Keep [roles.default]: it is also the reserved [roles.default] inheritance base.',
    )
    expect(notice).not.toContain('Delete')
    expect(notice).not.toContain('can be deleted')
  })

  test('…and with [roles.e2e] declared the alias is superseded, so nothing is said', () => {
    const parsed = withVerify(RESERVED_SKILL, '[roles.e2e]\nruntime = "claude"\n')
    expect(roleKeyWarnings(parsed)).toEqual([])
    expect(roleKeyDiagnostics(parsed).unconsumed).toEqual([])
  })

  test('a step NAMED `default` keeps step-name precedence, so its alias is inert', () => {
    // Pairs with the resolver's "reserved primary wins" case: the two can only
    // be wrong together.
    const parsed = withVerify(
      `[verify]
steps = ["default"]

[verify.default]
kind = "agent"
skill = "ab-verify-e2e"
`,
      '[roles.ab-verify-e2e]\nruntime = "claude"\n',
    )
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual([])
    expect(d.deprecated).toEqual([
      { key: 'ab-verify-e2e', activeAlias: [], supersededAlias: ['default'] },
    ])
    expect(roleKeyWarnings(parsed)[0]).toContain('[roles.ab-verify-e2e] can be deleted')
  })
})

describe('roleKeyWarnings — the one message set', () => {
  const BOTH_CLASSES = withVerify(
    E2E_STEP,
    '[roles.ab-verify-e2e]\nruntime = "claude"\n\n' +
      '[roles.ghost]\nruntime = "claude"\n\n[roles.typo]\nruntime = "claude"\n',
  )

  test('unconsumed line, then the valid-key line, then one notice per deprecated key', () => {
    const lines = roleKeyWarnings(BOTH_CLASSES)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(
      'autobuild.toml: [roles.ghost], [roles.typo] are declared but nothing requests ' +
        'them — their runtime and model never reach a session.',
    )
    expect(lines[1]).toBe(
      'Valid role keys: code-review, default, e2e, finalize, harvest, harvest-review, ' +
        'implement, plan, plan-review, reconcile, slug, upgrade',
    )
    expect(lines[2]).toContain('[roles.ab-verify-e2e] should be [roles.e2e]')
  })

  test('the valid-key list is its OWN string — no other line carries it', () => {
    const lines = roleKeyWarnings(BOTH_CLASSES)
    const validLine = lines[1]!
    expect(validLine.startsWith('Valid role keys: ')).toBe(true)
    for (const line of lines.filter((l) => l !== validLine)) {
      expect(line).not.toContain('Valid role keys')
      expect(line).not.toContain('harvest-review')
    }
  })

  test('the valid-key list never teaches the deprecated form', () => {
    expect(roleKeyDiagnostics(BOTH_CLASSES).valid).not.toContain('ab-verify-e2e')
  })

  test('the unconsumed line stops at the harm — it never says "inherits default"', () => {
    const [line] = roleKeyWarnings(BOTH_CLASSES)
    expect(line).not.toContain('inherit')
    expect(line).not.toContain('default')
  })

  test('a single unconsumed key reads in the singular', () => {
    const [line] = roleKeyWarnings(config(`${DEFAULT_ROLE}[roles.ghost]\nruntime = "claude"\n`))
    expect(line).toBe(
      'autobuild.toml: [roles.ghost] is declared but nothing requests it — its runtime ' +
        'and model never reach a session.',
    )
  })

  test('every notice names its key, and every deprecation its replacement, in the first 80 characters', () => {
    // The dashboard depends on this to land the actionable part on the first
    // rendered row; it is cheaper to pin here than from a painted frame.
    const parsed = withVerify(
      E2E_STEP,
      '[roles.ab-verify-e2e]\nruntime = "claude"\n\n[roles.ghost]\nruntime = "claude"\n',
    )
    for (const entry of roleKeyDiagnostics(parsed).deprecated) {
      const notice = roleKeyWarnings(parsed).find((line) => line.includes(`[roles.${entry.key}]`))!
      const head = notice.slice(0, 80)
      expect(head).toContain(`[roles.${entry.key}]`)
      for (const step of entry.activeAlias) expect(head).toContain(`[roles.${step}]`)
      for (const step of entry.supersededAlias) expect(head).toContain(`"${step}"`)
    }
  })
})
