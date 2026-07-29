import { describe, expect, test } from 'bun:test'
import { posix, resolve } from 'node:path'
import { readDistSkills } from './init'

const DIST_ROOT = resolve(import.meta.dir, '..', '..')

function withoutFencedCode(markdown: string): string {
  const lines = markdown.split('\n')
  let fence: '`' | '~' | undefined
  return lines
    .map((line) => {
      const opening = line.match(/^\s*(`{3,}|~{3,})/)
      if (opening) {
        const marker = opening[1]![0] as '`' | '~'
        if (fence === undefined) fence = marker
        else if (fence === marker) fence = undefined
        return ''
      }
      return fence === undefined ? line : ''
    })
    .join('\n')
}

function markdownTargets(markdown: string): string[] {
  const targets: string[] = []
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1]!.trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    target = target.split(/\s+["']/u, 1)[0]!
    targets.push(target)
  }
  return targets
}

describe('shipped skill self-containment', () => {
  test('every Autobuild-owned Markdown reference resolves in the installed ab-* tree', async () => {
    const skills = await readDistSkills(DIST_ROOT)
    const installedFiles = new Map<string, string>(
      skills.flatMap((skill) =>
        skill.files.map((file) => [`${skill.installName}/${file.path}`, file.content] as const),
      ),
    )
    const missing: string[] = []

    for (const [source, content] of installedFiles) {
      if (!source.endsWith('.md')) continue
      for (const rawTarget of markdownTargets(withoutFencedCode(content))) {
        if (/^(?:https?:|mailto:)/iu.test(rawTarget) || rawTarget.startsWith('#')) continue
        const targetPath = rawTarget.split('#', 1)[0]!
        if (targetPath === '') continue
        const resolved = posix.normalize(posix.join(posix.dirname(source), targetPath))
        if (
          targetPath.startsWith('/') ||
          resolved.startsWith('../') ||
          !installedFiles.has(resolved)
        ) {
          missing.push(`${source} -> ${rawTarget} (resolved ${resolved})`)
        }
      }
    }

    expect(missing, `unavailable installed skill references:\n${missing.join('\n')}`).toEqual([])
  })

  test('required guidance does not point agents at Autobuild source-checkout authorities', async () => {
    const skills = await readDistSkills(DIST_ROOT)
    const forbidden = [
      { name: 'SPEC authority', pattern: /\bSPEC(?:\.md|\s*§)/u },
      {
        name: 'source-only shared documentation',
        pattern: /\bdocs\/(?:spec-standard|remote-store-protocol)\.md\b/u,
      },
      {
        name: 'private Autobuild subsystem path',
        pattern: /\bsrc\/(?:cli|config|events|harvest|kernel|plugins|ports|processes|store)\//u,
      },
    ] as const
    const violations: string[] = []

    for (const skill of skills) {
      for (const file of skill.files) {
        if (!file.path.endsWith('.md')) continue
        const source = withoutFencedCode(file.content)
        for (const rule of forbidden) {
          if (rule.pattern.test(source)) {
            violations.push(`${skill.installName}/${file.path}: ${rule.name}`)
          }
        }
      }
    }

    expect(violations, `source-checkout skill authorities:\n${violations.join('\n')}`).toEqual([])
  })

  test('installed guide references are exact copies of their public documents', async () => {
    const skills = await readDistSkills(DIST_ROOT)
    const guide = skills.find((skill) => skill.installName === 'ab-guide')
    expect(guide).toBeDefined()

    for (const name of ['spec-standard.md', 'remote-store-protocol.md']) {
      const installed = guide!.files.find((file) => file.path === `references/${name}`)
      expect(installed, `missing ab-guide/references/${name}`).toBeDefined()
      expect(installed!.content).toBe(await Bun.file(`${DIST_ROOT}/docs/${name}`).text())
    }
  })
})
