import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseConfig } from './load'

const root = resolve(import.meta.dir, '../../../..')
const pages = [
  'ticket-sources',
  'agent-runtimes',
  'workspaces',
  'forges',
  'build-store',
  'dispatcher-hosting',
  'operator-surfaces',
  'plugin-authoring',
]

test('complete seam configurations parse through the production schema', async () => {
  const configs = new Map<string, ReturnType<typeof parseConfig>[]>()
  for (const page of pages) {
    const text = await readFile(resolve(root, 'docs', `${page}.md`), 'utf8')
    const blocks = [
      ...text.matchAll(
        /<!-- seam-config:start -->\n```toml\n([\s\S]*?)\n```\n<!-- seam-config:end -->/g,
      ),
    ]
    if (page !== 'plugin-authoring') expect(blocks.length).toBeGreaterThan(0)
    configs.set(
      page,
      blocks.map((block) => parseConfig(block[1]!, `${page}.md`)),
    )
    if (page === 'plugin-authoring') {
      const walkthrough = text.match(
        /<!-- plugin-authoring-walkthrough-config:start -->\n```toml\n([\s\S]*?)\n```/,
      )
      expect(walkthrough).not.toBeNull()
      const config = parseConfig(walkthrough![1]!)
      expect(config.plugins).toEqual(['./autobuild-plugin.ts'])
      expect(config.tickets.source).toBe('walkthrough')
    }
  }
  expect(configs.get('ticket-sources')!.map((config) => config.tickets.source)).toEqual([
    'file',
    'linear',
    'hosted',
  ])
  expect(configs.get('ticket-sources')![0]!.tickets.dir).toBe('.tickets')
  expect(configs.get('ticket-sources')![1]!.tickets.readyLabels).toEqual(['autobuild'])
  expect(configs.get('ticket-sources')![2]!.tickets.url).toBe('https://tickets.example.com')
  expect(
    configs
      .get('agent-runtimes')!
      .slice(0, 3)
      .map((config) => config.roles.default!.runtime),
  ).toEqual(['claude', 'codex', 'pi'])
  const roles = configs.get('agent-runtimes')![3]!.roles
  for (const role of ['default', 'plan', 'implement']) {
    expect(roles[role]!.runtime).toBe('codex')
    expect(roles[role]!.model).toBe('gpt-6.1-sol')
    expect(roles[role]!.alternates).toEqual([{ runtime: 'claude', model: 'claude-opus-5-5' }])
  }
  for (const role of ['plan-review', 'code-review', 'acceptance']) {
    expect(roles[role]!.runtime).toBe('claude')
    expect(roles[role]!.model).toBe('claude-opus-5-5')
    expect(roles[role]!.alternates).toEqual([{ runtime: 'codex', model: 'gpt-6.1-sol' }])
  }
  const remote = configs.get('workspaces')![1]!
  expect(configs.get('workspaces')![0]!.workspace.provider).toBe('git-worktree')
  expect(remote.workspace.provider).toBe('vercel-sandbox')
  expect(remote.plugins).toEqual(['@defrex/autobuild-vercel-sandbox'])
  expect(remote.store?.url).toBe('https://builds.example.com')
  expect(remote.workspace.config.gitUsernameEnv).toBe('AB_GIT_READ_USER')
  expect(remote.workspace.config.gitPasswordEnv).toBe('AB_GIT_READ_TOKEN')
  expect(remote.workspace.config.environmentVariables).toEqual(['AI_GATEWAY_API_KEY'])
  expect(remote.workspace.config.runtimeProvisioning).toHaveProperty('pi')
  expect(configs.get('forges')!.map((config) => config.forge)).toEqual([
    'github',
    'local-git',
    'acme',
  ])
  expect(configs.get('forges')![2]!.plugins).toEqual(['./autobuild-plugin.ts'])
  expect(configs.get('build-store')![0]!.store).toBeUndefined()
  expect(configs.get('build-store')![1]!.store?.url).toBe('https://builds.example.com')
  const hosted = configs.get('dispatcher-hosting')![1]!
  expect(hosted.workspace.provider).toBe('vercel-sandbox')
  expect(hosted.tickets.source).toBe('hosted')
  expect(hosted.plugins).toEqual(['@defrex/autobuild-vercel-sandbox'])
  expect(configs.get('operator-surfaces')![1]!.store?.url).toBe('https://builds.example.com')
})
