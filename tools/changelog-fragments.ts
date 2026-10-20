import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const FRAGMENT_DIRECTORY = '.changelog'

export function fragmentPath(number: number): string {
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error('PR must be a safe positive integer')
  return `${FRAGMENT_DIRECTORY}/${number}.md`
}

export function parseFragment(path: string, content: string): { number: number; entry: string } {
  const name = /^\.changelog\/([1-9]\d*)\.md$/.exec(path)
  const number = Number(name?.[1])
  if (!name || !Number.isSafeInteger(number) || number <= 0)
    throw new Error(`Malformed changelog fragment filename: ${path}`)
  const match = /^- \[#([1-9]\d*)\]\(([^\s()]+)\) — (\S[^\r\n]*)\n$/.exec(content)
  if (!match || Number(match[1]) !== number || match[3]?.trim() !== match[3]) {
    throw new Error(`Malformed changelog fragment: ${path}`)
  }
  return { number, entry: content.slice(0, -1) }
}

export function renderFragment(number: number, url: string, title: string): string {
  const content = `- [#${number}](${url}) — ${title}\n`
  parseFragment(fragmentPath(number), content)
  return content
}

export async function readFragments(root: string) {
  let names: string[]
  try {
    names = await readdir(join(root, FRAGMENT_DIRECTORY))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return Promise.all(
    names
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map(async (name) => {
        const path = `${FRAGMENT_DIRECTORY}/${name}`
        return { path, ...parseFragment(path, await readFile(join(root, path), 'utf8')) }
      }),
  )
}

/** Preserve the released suffix verbatim; legacy prose follows sorted PR entries. */
export async function collectPendingChangelog(root: string, changelog: string) {
  const headings = [...changelog.matchAll(/^## Unreleased[\t ]*$/gm)]
  if (headings.length !== 1)
    throw new Error(
      `CHANGELOG.md must contain exactly one "## Unreleased" heading (found ${headings.length})`,
    )
  const start = changelog.indexOf('\n', headings[0]!.index) + 1 || changelog.length
  const next = /^## .+$/gm
  next.lastIndex = start
  const end = next.exec(changelog)?.index ?? changelog.length
  const fragments = await readFragments(root)
  const prs = new Map<number, string>()
  const legacy: string[] = []
  const add = (number: number, entry: string) => {
    fragmentPath(number)
    if (prs.has(number)) throw new Error(`Duplicate pending PR #${number}`)
    prs.set(number, entry)
  }
  for (const line of changelog.slice(start, end).trim().split('\n')) {
    const marker = /^- \[#([1-9]\d*)\]\(/.exec(line)
    if (marker) add(Number(marker[1]), line)
    else legacy.push(line)
  }
  for (const fragment of fragments) add(fragment.number, fragment.entry)
  const entries = [...[...prs].sort(([a], [b]) => b - a).map(([, entry]) => entry), ...legacy]
    .join('\n')
    .trim()
  if (!entries)
    throw new Error('CHANGELOG.md Unreleased section has no entries and no pending fragments')
  return {
    entries,
    paths: fragments.map(({ path }) => path).sort(),
    content: `${changelog.slice(0, start)}\n${entries}\n\n${changelog.slice(end)}`,
  }
}
