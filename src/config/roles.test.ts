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

  test('a shared skill names only the steps it still routes, and never advises deletion', () => {
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
      '[roles.e2e]\nruntime = "claude"\n\n[roles.ab-verify-e2e]\nruntime = "claude"\n',
    )
    const d = roleKeyDiagnostics(parsed)
    expect(d.unconsumed).toEqual([])
    expect(d.deprecated).toEqual([
      { key: 'ab-verify-e2e', activeAlias: ['visual'], supersededAlias: ['e2e'] },
    ])
    const [notice] = roleKeyWarnings(parsed)
    expect(notice).toContain('[roles.ab-verify-e2e] should be [roles.visual]')
    expect(notice).toContain(
      'Keep [roles.ab-verify-e2e]: it is also the superseded skill-name key for "e2e".',
    )
    expect(notice).not.toContain('can be deleted')
    expect(notice).not.toContain('Delete')
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
