import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseConfig } from './load'

const root = resolve(import.meta.dir, '../../../..')
const pages = [
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
