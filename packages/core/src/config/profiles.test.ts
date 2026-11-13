/**
 * Label-selected role profiles (SPEC §9): the pure overlay, selection and
 * diagnostic helpers, and the configuration refusals `parseConfig` applies.
 */
import { describe, expect, test } from 'bun:test'
import { ConfigError, parseConfig } from './load'
import {
  normalizeProfileLabel,
  profileConflictDiagnostic,
  profileRoles,
  selectProfile,
} from './profiles'
import { effectiveRuntimeReferences } from './roles'
import type { RoleConfig } from './schema'

const BASE = `[tickets]
source = "file"
readyState = "ready"

[roles.default]
runtime = "claude"
`

function config(body: string) {
  return parseConfig(`${BASE}\n${body}`, 'autobuild.toml', () => {})
}

function refusal(body: string): string {
  try {
    config(body)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as Error).message
  }
  throw new Error('expected parseConfig to refuse the profile')
}

describe('profileRoles', () => {
  const roles: Record<string, RoleConfig> = {
    default: { runtime: 'claude' },
    implement: { model: 'claude-sonnet-5-5', args: ['--a'], alternates: [{ runtime: 'pi' }] },
  }

  test('an entry overlays only its declared fields on the repository role', () => {
    const overlaid = profileRoles(roles, { implement: { model: 'claude-opus-5-5' } })
    expect({ ...overlaid.implement }).toEqual({
      model: 'claude-opus-5-5',
      args: ['--a'],
      alternates: [{ runtime: 'pi' }],
    })
    expect(overlaid.default).toBe(roles.default)
    expect(roles.implement!.model).toBe('claude-sonnet-5-5')
  })

  test('an entry on an undeclared role stands alone, and a declared alternates list replaces', () => {
    const overlaid = profileRoles(roles, {
      plan: { model: 'claude-opus-5-5' },
      implement: { alternates: [] },
    })
    expect({ ...overlaid.plan }).toEqual({ model: 'claude-opus-5-5' })
    expect(overlaid.implement!.alternates).toEqual([])
  })

  test('a __proto__ entry stays an own key', () => {
    const entries = Object.create(null) as Record<string, { model?: string }>
    Object.defineProperty(entries, '__proto__', {
      value: { model: 'claude-opus-5-5' },
      enumerable: true,
    })
    const overlaid = profileRoles<{ model?: string }>({}, entries)
    expect(Object.hasOwn(overlaid, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(overlaid, '__proto__')!.value.model).toBe(
      'claude-opus-5-5',
    )
  })
})

describe('selectProfile', () => {
  const profiles = { deep: { label: 'deep' }, cheap: { label: ' Budget ' } }

  test('no matching label selects no profile', () => {
    expect(selectProfile(profiles, ['autobuild'])).toEqual({ kind: 'none' })
    expect(selectProfile(profiles, [])).toEqual({ kind: 'none' })
    expect(selectProfile({}, ['deep'])).toEqual({ kind: 'none' })
  })

  test('labels match case-insensitively after trimming', () => {
    expect(normalizeProfileLabel(' Deep ')).toBe('deep')
    expect(selectProfile(profiles, ['DEEP'])).toEqual({ kind: 'selected', name: 'deep' })
    expect(selectProfile(profiles, ['budget'])).toEqual({ kind: 'selected', name: 'cheap' })
  })

  test('two profiles matching is a conflict, sorted by profile name', () => {
    expect(selectProfile(profiles, ['deep', 'budget'])).toEqual({
      kind: 'conflict',
      matches: [
        { name: 'cheap', label: ' Budget ' },
        { name: 'deep', label: 'deep' },
      ],
    })
  })

  test('the conflict diagnostic names the ticket, the labels and the profiles', () => {
    expect(
      profileConflictDiagnostic('T-7', [
        { name: 'cheap', label: 'budget' },
        { name: 'deep', label: 'deep' },
      ]),
    ).toBe(
      'ticket T-7: labels "budget" and "deep" select more than one profile ("cheap", "deep") — remove all but one profile label to make it claimable',
    )
  })
})

describe('[profiles] configuration', () => {
  test('a repository without [profiles] parses to an empty map', () => {
    expect(config('').profiles).toEqual({})
  })

  test('a profile declares one label and role entries for any role', () => {
    const parsed = config(`
[profiles.deep]
label = "deep"

[profiles.deep.roles.plan-review]
model = "claude-opus-5-5"

[profiles.deep.roles.acceptance]
args = ["--effort", "high"]
`)
    expect(parsed.profiles.deep!.label).toBe('deep')
    expect(Object.keys(parsed.profiles.deep!.roles)).toEqual(['plan-review', 'acceptance'])
  })

  test('two profiles declaring the same label are refused, naming both', () => {
    const message = refusal(`
[profiles.deep]
label = "deep"

[profiles.thorough]
label = " DEEP "
`)
    expect(message).toContain('profiles.thorough.label')
    expect(message).toContain('profiles "deep" and "thorough" both declare label "DEEP"')
  })

  test('a missing or blank label is refused', () => {
    expect(refusal('[profiles.deep]\n')).toContain('profiles.deep.label')
    expect(refusal('[profiles.deep]\nlabel = "  "\n')).toContain(
      'profile "deep" needs a nonblank label',
    )
  })

  test('a default entry is refused', () => {
    const message = refusal(`
[profiles.deep]
label = "deep"

[profiles.deep.roles.default]
model = "claude-opus-5-5"
`)
    expect(message).toContain('profiles.deep.roles.default')
    expect(message).toContain('profile "deep" cannot override the reserved default role')
  })

  test('an entry naming an unknown account is refused like a role entry', () => {
    const message = refusal(`
[profiles.deep]
label = "deep"

[profiles.deep.roles.implement]
account = "missing"
`)
    expect(message).toContain('profiles.deep.roles.implement')
    expect(message).toContain('profile "deep" role "implement"')
  })

  test('readiness references include a runtime only a profile selects', () => {
    const parsed = config(`
[profiles.deep]
label = "deep"

[profiles.deep.roles.code-review]
runtime = "codex"
model = "gpt-5.6-sol"
`)
    const codex = effectiveRuntimeReferences(parsed).find((group) => group.runtime === 'codex')
    expect(codex?.references).toEqual(['profile "deep" role "code-review" primary'])
    expect(codex?.models).toEqual(['gpt-5.6-sol'])
  })
})
