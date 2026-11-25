import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { vercelSandboxConfigSchema } from '../config/schema'
import { hostedOperatorSandboxComposition } from './sandbox-host'
import { SandboxUnavailableError } from './sandbox-resolver'

const READY = '[tickets]\nsource = "file"\nreadyState = "ready"\n'
const WORKTREE = parseConfig(
  `baseBranch = "trunk"\n${READY}[commands]\nsetup = "bun install"\n[orchestrator.sandbox]\nenvironmentVariables = ["MY_TOOL"]\n`,
)
const VERCEL = parseConfig(
  `${READY}[workspace]\nprovider = "vercel-sandbox"\n[workspace.config]\ntimeoutSeconds = 600\n[workspace.config.runtimeProvisioning]\n`,
)
const TOKEN = 'deploy-forge-secret'

function refusal(env: Record<string, string | undefined>): SandboxUnavailableError {
  try {
    hostedOperatorSandboxComposition(WORKTREE, env)
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxUnavailableError)
    return error as SandboxUnavailableError
  }
  throw new Error('expected a refusal')
}

describe('hostedOperatorSandboxComposition', () => {
  test('a vercel-sandbox project passes through with no credential check', () => {
    const result = hostedOperatorSandboxComposition(VERCEL, {})
    expect(result).toEqual({ config: VERCEL, fallback: false })
    expect(result.config).toBe(VERCEL)
  })

  test('any other provider gets the deployment Vercel provider with an egress-only token', () => {
    const env = { GITHUB_TOKEN: TOKEN, VERCEL_OIDC_TOKEN: 'oidc' }
    const before = JSON.stringify(env)
    const result = hostedOperatorSandboxComposition(WORKTREE, env)
    expect(result.fallback).toBe(true)
    expect(result.egressReadCredential).toEqual({ username: 'x-access-token', password: TOKEN })
    expect(result.config.workspace.provider).toBe('vercel-sandbox')
    const workspace = vercelSandboxConfigSchema.parse(result.config.workspace.config)
    expect(workspace.gitUsernameEnv).toBeUndefined()
    expect(workspace.gitPasswordEnv).toBeUndefined()
    expect(JSON.stringify(result.config)).not.toContain(TOKEN)
    for (const key of ['orchestrator', 'commands', 'forge', 'baseBranch'] as const) {
      expect(result.config[key]).toEqual(WORKTREE[key])
    }
    expect(JSON.stringify(env)).toBe(before)
    expect(WORKTREE.workspace.provider).toBe('git-worktree')
  })

  test('GH_TOKEN alone and the durable Vercel triple are accepted; blank GITHUB_TOKEN does not mask GH_TOKEN', () => {
    const result = hostedOperatorSandboxComposition(WORKTREE, {
      GITHUB_TOKEN: '',
      GH_TOKEN: TOKEN,
      VERCEL_TOKEN: 't',
      VERCEL_TEAM_ID: 'team',
      VERCEL_PROJECT_ID: 'project',
    })
    expect(result.egressReadCredential?.password).toBe(TOKEN)
  })

  test('missing credentials refuse naming exactly the missing groups, never a value', () => {
    const vercel = refusal({ GITHUB_TOKEN: TOKEN, VERCEL_TOKEN: 'partial-secret' })
    expect(vercel.reason).toBe('credentials-missing')
    expect(vercel.message).toContain('VERCEL_OIDC_TOKEN')
    expect(vercel.message).not.toContain('GITHUB_TOKEN or GH_TOKEN')
    expect(vercel.message).not.toContain('partial-secret')
    expect(vercel.message).not.toContain(TOKEN)
    const forge = refusal({ VERCEL_OIDC_TOKEN: 'oidc' })
    expect(forge.message).toContain('GITHUB_TOKEN or GH_TOKEN')
    expect(forge.message).not.toContain('VERCEL_OIDC_TOKEN')
    const both = refusal({})
    expect(both.message).toContain('VERCEL_OIDC_TOKEN')
    expect(both.message).toContain('GITHUB_TOKEN or GH_TOKEN')
  })
})
