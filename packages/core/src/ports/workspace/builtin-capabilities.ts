/**
 * The full capability object for the builtin workspace providers (AUT-516).
 * The parse-time subset lives in `config/schema.ts`'s
 * `BUILTIN_WORKSPACE_PROVIDER_CONFIG` because config validation must be
 * statically reachable without the registry; this module assembles the FULL
 * declarations — including the registry-seam behaviors — and is attached to
 * the builtin registrations by `plugins/registry.ts`.
 *
 * Import graph discipline: this module imports `config/schema.ts` and
 * `git-worktree.ts`; nothing imports it from `schema.ts`, so no cycle exists.
 * The construction-site `configRefusal` for git-worktree is set EXPLICITLY
 * here, not copied from the table's parse-site `configRefusalMessage` — the
 * two strings differ by design (the parse-site message adds the remediation
 * clause; the construction-site one does not). Every non-builtin workspace
 * provider arrives through a plugin registration (AUT-505).
 */
import { join, resolve } from 'node:path'
import type { WorkspaceConfig } from '../../config/schema'
import type { WorkspaceProviderCapabilities } from './provider-capabilities'
import type { CreateWorkspaceProviderOptions } from './create'
import { GitWorktreeProvider } from './git-worktree'
import type { WorkspaceProvider } from '../types'

/** The git-worktree construction-site refusal: no remediation clause, unlike
 * the parse-site message in the config table. */
const GIT_WORKTREE_CONSTRUCTION_REFUSAL =
  '[workspace.config] is not supported by the builtin "git-worktree" provider'

interface BuiltinWorkspaceProviderDeclaration {
  capabilities: WorkspaceProviderCapabilities
  builtinFactory: (
    config: WorkspaceConfig,
    opts: CreateWorkspaceProviderOptions,
    parsed: unknown,
  ) => WorkspaceProvider | Promise<WorkspaceProvider>
}

const BUILTINS: Record<string, BuiltinWorkspaceProviderDeclaration> = {
  'git-worktree': {
    capabilities: {
      configRefusal: GIT_WORKTREE_CONSTRUCTION_REFUSAL,
    },
    builtinFactory(_config, opts) {
      // Its provider config is always `{}`: the refusal (parse site and
      // construction site alike) has already rejected anything else.
      return new GitWorktreeProvider({
        root: resolve(opts.worktreeRoot),
        sandboxRoot:
          opts.sandboxRoot ?? resolve(join(opts.worktreeRoot, '..', 'orchestrator-sandboxes')),
        setupCommand: opts.sandboxSetupCommand,
        sandboxEnvironmentVariables: opts.sandboxEnvironmentVariables,
        envSource: opts.env,
      })
    },
  },
}

/** The FULL capability object of a builtin workspace provider, `undefined`
 * for any other name. Used by pre-registry seams (guest probe, init
 * preflight) that cannot consult the plugin registry. */
export function builtinWorkspaceProviderCapabilities(
  name: string,
): WorkspaceProviderCapabilities | undefined {
  return BUILTINS[name]?.capabilities
}

/** The builtin registration extras for `plugins/registry.ts`: the capability
 * object plus the host-owned construction closure. */
export function builtinWorkspaceProviderRegistration(
  name: string,
): BuiltinWorkspaceProviderDeclaration | undefined {
  const builtin = BUILTINS[name]
  return builtin === undefined
    ? undefined
    : { capabilities: builtin.capabilities, builtinFactory: builtin.builtinFactory }
}
