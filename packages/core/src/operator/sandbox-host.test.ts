/**
 * The checkout-less hosted operator-sandbox composition (AUT-584): the
 * helper builds the same backend `ab mcp` builds from a checkout, from a
 * deposited effective config plus injected seams. Construction-only
 * assertions — no provider SDK calls, no network.
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { FakeForge } from '../ports/forge/fake'
import { GitHubApiError } from '../ports/forge/github-transport'
import { MemoryBuildStore } from '../store/memory'
import { buildRegistry } from './registry'
import { createHostedOperatorSandboxService, remoteBranchHeadFromForge } from './sandbox-host'

const REPO = 'https://github.com/acme/widgets'

const STORE_REF = 'https://hosted.test'
const STORE_TOKEN = 'repo-scoped-token'

function compositionConfig(workspace: 'git-worktree' | 'vercel-sandbox') {
  return parseConfig(
    workspace === 'git-worktree'
      ? `
[workspace]
provider = "git-worktree"
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
`
      : `
[workspace]
provider = "vercel-sandbox"
[workspace.config]
timeoutSeconds = 3600
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
`,
  )
}

const OIDC_ENV = { VERCEL_OIDC_TOKEN: 'header-oidc-token' }

async function compose(opts: {
  workspace: 'git-worktree' | 'vercel-sandbox'
  forge?: FakeForge
  env?: Record<string, string | undefined>
}) {
  const store = new MemoryBuildStore()
  const service = await createHostedOperatorSandboxService({
    store,
    repo: REPO,
    config: compositionConfig(opts.workspace),
    env: opts.env ?? {},
    storeRef: STORE_REF,
    storeToken: STORE_TOKEN,
    ...(opts.forge !== undefined ? { forge: opts.forge } : {}),
  })
  return { store, service }
}

function sandboxToolNames(entries: readonly { name: string }[]): string[] {
  return entries.map((entry) => entry.name).filter((name) => name.startsWith('sandbox.'))
}

describe('remoteBranchHeadFromForge', () => {
  test('maps a 404 GitHubApiError to an absent branch and rethrows everything else', async () => {
    const forge = new FakeForge()
    forge.seedBranch('main', 'sha-main')
    expect(await remoteBranchHeadFromForge(forge)('main')).toBe('sha-main')

    const failing = {
      remoteBranchSha: async (branch: string): Promise<string> => {
        throw new GitHubApiError(404, `branch ${branch} not found`)
      },
    } as unknown as FakeForge
    expect(await remoteBranchHeadFromForge(failing)('absent')).toBeUndefined()

    const serverError = {
      remoteBranchSha: async (): Promise<string> => {
        throw new GitHubApiError(500, 'github is down')
      },
    } as unknown as FakeForge
    await expect(remoteBranchHeadFromForge(serverError)('main')).rejects.toMatchObject({
      status: 500,
    })

    const otherError = {
      remoteBranchSha: async (): Promise<string> => {
        throw new Error('network unreachable')
      },
    } as unknown as FakeForge
    await expect(remoteBranchHeadFromForge(otherError)('main')).rejects.toThrow(
      'network unreachable',
    )
  })
})

describe('createHostedOperatorSandboxService', () => {
  test('composes the git-worktree builtin without store requirements or network', async () => {
    const { store, service } = await compose({ workspace: 'git-worktree' })
    const registry = buildRegistry({ store, sandbox: service })
    const tools = sandboxToolNames(registry.entries)
    // The git-worktree provider publishes through host git from the sandbox
    // worktree, so with the forge wired every sandbox tool serves.
    expect(tools.sort()).toEqual([
      'sandbox.exec',
      'sandbox.publish',
      'sandbox.read_file',
      'sandbox.reset',
      'sandbox.start',
      'sandbox.wait',
      'sandbox.write_file',
    ])
    expect(service.canPublish).toBe(true)
  })

  test('composes the vercel-sandbox builtin with an OIDC credential: seven tools and canPublish true', async () => {
    const forge = new FakeForge()
    const { store, service } = await compose({
      workspace: 'vercel-sandbox',
      forge,
      env: OIDC_ENV,
    })
    const registry = buildRegistry({ store, sandbox: service })
    const tools = sandboxToolNames(registry.entries)
    expect(tools.sort()).toEqual([
      'sandbox.exec',
      'sandbox.publish',
      'sandbox.read_file',
      'sandbox.reset',
      'sandbox.start',
      'sandbox.wait',
      'sandbox.write_file',
    ])
    expect(service.canPublish).toBe(true)
  })

  test('a vercel-sandbox config also constructs with the durable VERCEL_TOKEN triple', async () => {
    const { service } = await compose({
      workspace: 'vercel-sandbox',
      forge: new FakeForge(),
      env: {
        VERCEL_TOKEN: 'durable-token',
        VERCEL_TEAM_ID: 'team',
        VERCEL_PROJECT_ID: 'project',
      },
    })
    expect(service.canPublish).toBe(true)
  })

  test('a vercel-sandbox config with a credential-less env fails construction with the vercelSdkCredentials message', async () => {
    await expect(compose({ workspace: 'vercel-sandbox', forge: new FakeForge() })).rejects.toThrow(
      'vercel-sandbox requires VERCEL_OIDC_TOKEN or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID',
    )
  })

  test('an injected forge whose table lacks remoteBranchSha fails construction naming the forge', async () => {
    const capabilityLess = {} as unknown as FakeForge
    await expect(
      createHostedOperatorSandboxService({
        store: new MemoryBuildStore(),
        repo: REPO,
        config: compositionConfig('git-worktree'),
        env: {},
        storeRef: STORE_REF,
        storeToken: STORE_TOKEN,
        forge: capabilityLess,
      }),
    ).rejects.toThrow('the configured forge "github" does not resolve remote branch heads')
  })

  test('a plugin-provider config fails construction with the provider-not-found message', async () => {
    const config = parseConfig(`
[workspace]
provider = "from-some-plugin"
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
`)
    await expect(
      createHostedOperatorSandboxService({
        store: new MemoryBuildStore(),
        repo: REPO,
        config,
        env: {},
        storeRef: STORE_REF,
        storeToken: STORE_TOKEN,
        forge: new FakeForge(),
      }),
    ).rejects.toThrow('unknown workspace provider "from-some-plugin"')
  })

  test('an unknown configured forge fails construction naming it', async () => {
    const config = parseConfig(`
forge = "not-a-forge"
[workspace]
provider = "git-worktree"
[tickets]
source = "file"
readyState = "ready"
[verify]
steps = []
[finalize]
steps = []
`)
    await expect(
      createHostedOperatorSandboxService({
        store: new MemoryBuildStore(),
        repo: REPO,
        config,
        env: {},
        storeRef: STORE_REF,
        storeToken: STORE_TOKEN,
      }),
    ).rejects.toThrow('unknown forge adapter "not-a-forge"')
  })
})
