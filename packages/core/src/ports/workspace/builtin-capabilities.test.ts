import { describe, expect, test } from 'bun:test'
import { BUILTIN_WORKSPACE_PROVIDER_CONFIG } from '../../config/schema'
import {
  builtinWorkspaceProviderCapabilities,
  builtinWorkspaceProviderNames,
  builtinWorkspaceProviderRegistration,
} from './builtin-capabilities'

/**
 * Parity between the two host-maintained builtin declaration tables
 * (AUT-573): the parse-time subset in `config/schema.ts`'s
 * `BUILTIN_WORKSPACE_PROVIDER_CONFIG` and the FULL capability declarations
 * in `builtin-capabilities.ts`'s private `BUILTINS` record, reached through
 * the module's accessors. Two parallel tables describing one builtin set is
 * exactly the shape that silently drops half of a future provider's
 * declaration; these pins make that PR fail here instead.
 *
 * Failure messages name the provider and both tables on purpose: a future
 * divergence here is a decision to make, not a string edit.
 */
describe('builtin workspace-provider table parity', () => {
  test('BUILTINS and the config table name the same provider set', () => {
    const names = builtinWorkspaceProviderNames()
    const tableNames = [...BUILTIN_WORKSPACE_PROVIDER_CONFIG.keys()]
    for (const name of names) {
      expect(
        BUILTIN_WORKSPACE_PROVIDER_CONFIG.has(name),
        `"${name}" is declared in builtin-capabilities.ts's BUILTINS but has no ` +
          'BUILTIN_WORKSPACE_PROVIDER_CONFIG entry in config/schema.ts — a builtin added ' +
          'to only one table silently lacks the other half of its declaration',
      ).toBe(true)
    }
    for (const name of tableNames) {
      expect(
        names.includes(name),
        `"${name}" is declared in config/schema.ts's BUILTIN_WORKSPACE_PROVIDER_CONFIG but ` +
          'has no BUILTINS entry in builtin-capabilities.ts — a builtin added to only one ' +
          'table silently lacks the other half of its declaration',
      ).toBe(true)
    }
  })

  test('refusal presence pairs between the config table and the capability', () => {
    for (const name of builtinWorkspaceProviderNames()) {
      const declaration = BUILTIN_WORKSPACE_PROVIDER_CONFIG.get(name)
      const capabilities = builtinWorkspaceProviderCapabilities(name)
      if (declaration === undefined || capabilities === undefined) continue
      expect(
        (declaration.configRefusalMessage !== undefined) ===
          (capabilities.configRefusal !== undefined),
        `"${name}" declares configRefusalMessage on one table only: the parse-site ` +
          'declaration in config/schema.ts carries configRefusalMessage=' +
          `${JSON.stringify(declaration.configRefusalMessage ?? null)} while the ` +
          'construction-site capability in builtin-capabilities.ts carries configRefusal=' +
          `${JSON.stringify(capabilities.configRefusal ?? null)} — a refusal on one site ` +
          'only lets [workspace.config] through the other',
      ).toBe(true)
    }
  })

  test('the construction-site refusal is a prefix of the parse-site refusal', () => {
    // The two refusal texts differ by design: the parse-site message appends
    // the remediation clause the construction-site one omits. If a future
    // builtin's texts diverge beyond that trailing clause, this pin forces a
    // deliberate decision about whether they should still be prefix-related —
    // the fix is a decision, not a string edit.
    for (const name of builtinWorkspaceProviderNames()) {
      const declaration = BUILTIN_WORKSPACE_PROVIDER_CONFIG.get(name)
      const capabilities = builtinWorkspaceProviderCapabilities(name)
      if (declaration === undefined || capabilities === undefined) continue
      if (
        declaration.configRefusalMessage === undefined ||
        capabilities.configRefusal === undefined
      )
        continue
      expect(
        declaration.configRefusalMessage.startsWith(capabilities.configRefusal),
        `"${name}": the construction-site configRefusal is not a prefix of the parse-site ` +
          `configRefusalMessage — construction=${JSON.stringify(capabilities.configRefusal)}, ` +
          `parse=${JSON.stringify(declaration.configRefusalMessage)}. The parse-site message ` +
          'adds only the remediation clause; a different relationship needs a deliberate ' +
          'decision recorded in both modules',
      ).toBe(true)
    }
  })

  test('configSchema is the same object in both tables', () => {
    for (const name of builtinWorkspaceProviderNames()) {
      const declaration = BUILTIN_WORKSPACE_PROVIDER_CONFIG.get(name)
      const capabilities = builtinWorkspaceProviderCapabilities(name)
      if (declaration === undefined || capabilities === undefined) continue
      if (declaration.configSchema === undefined) {
        expect(
          capabilities.configSchema,
          `"${name}": the config table declares no configSchema but the capability in ` +
            'builtin-capabilities.ts does — the two halves of the declaration disagree ' +
            'about whether [workspace.config] is schema-validated',
        ).toBeUndefined()
      } else {
        expect(
          capabilities.configSchema,
          `"${name}": the capability's configSchema is not the config table's schema object — ` +
            'derive the parse-time subset (as vercel-capabilities.ts pickConfigDeclaration ' +
            'does) instead of copying it, so the two cannot drift',
        ).toBe(declaration.configSchema)
      }
    }
  })

  test('the parse-time subset fields agree between the two tables', () => {
    for (const name of builtinWorkspaceProviderNames()) {
      const declaration = BUILTIN_WORKSPACE_PROVIDER_CONFIG.get(name)
      const capabilities = builtinWorkspaceProviderCapabilities(name)
      if (declaration === undefined || capabilities === undefined) continue
      expect(
        (declaration.requireRuntimeProvisioning ?? false) ===
          (capabilities.requireRuntimeProvisioning ?? false),
        `"${name}": requireRuntimeProvisioning is ${JSON.stringify(
          declaration.requireRuntimeProvisioning ?? false,
        )} in the config table but ${JSON.stringify(
          capabilities.requireRuntimeProvisioning ?? false,
        )} on the capability`,
      ).toBe(true)
      expect(
        (declaration.sandboxForbiddenEnv ?? []).join(',') ===
          (capabilities.sandboxForbiddenEnv ?? []).join(','),
        `"${name}": sandboxForbiddenEnv is [${(declaration.sandboxForbiddenEnv ?? []).join(',')}] ` +
          `in the config table but [${(capabilities.sandboxForbiddenEnv ?? []).join(',')}] ` +
          'on the capability',
      ).toBe(true)
    }
  })

  test('the accessors return the same capability object for every builtin', () => {
    for (const name of builtinWorkspaceProviderNames()) {
      expect(
        builtinWorkspaceProviderRegistration(name)?.capabilities,
        `"${name}": builtinWorkspaceProviderRegistration does not return the same capability ` +
          'object builtinWorkspaceProviderCapabilities provides — the pre-registry seams ' +
          'and the registry seam would enforce different declarations',
      ).toBe(builtinWorkspaceProviderCapabilities(name))
    }
  })
})
