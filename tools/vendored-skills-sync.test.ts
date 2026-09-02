/*
 * This repository holds every distributed `ab-*` skill to its canonical
 * install form in both the live and `.ab-pristine` trees. This is repository
 * policy, not product behavior, so the guard lives in `tools/` rather than
 * `packages/core/src/`.
 *
 * Canonical inventory and expected bytes come from the same reader used by
 * `ab init`. That keeps discovery, complete support-file trees, and SKILL.md
 * frontmatter rewriting aligned with the real vendoring path. This repository
 * permits no divergence for canonical skills, so there is deliberately no
 * exception list. Repository-local and retired skills have no canonical
 * inventory entry and are therefore left alone.
 */
import { describe, expect, test } from 'bun:test'
import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DistSkillFile } from '../packages/core/src/cli/init'
import { readDistSkills } from '../packages/core/src/cli/init'

const REPO_ROOT = resolve(import.meta.dir, '..')

/** Every regular file under `root`, keyed by its POSIX relative path. */
async function readTree(root: string, prefix = ''): Promise<Map<string, string>> {
  let entries: Dirent[]
  try {
    entries = await readdir(join(root, ...prefix.split('/').filter(Boolean)), {
      withFileTypes: true,
    })
  } catch (error) {
    if (prefix === '' && (error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }

  const files = new Map<string, string>()
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      for (const [nested, content] of await readTree(root, path)) files.set(nested, content)
    } else if (entry.isFile()) {
      files.set(path, await readFile(join(root, ...path.split('/')), 'utf8'))
    }
  }
  return files
}

function expectedTree(files: DistSkillFile[]): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.content]))
}

function sortedPaths(tree: Map<string, string>): string[] {
  return [...tree.keys()].sort()
}

function driftedPaths(expected: Map<string, string>, actual: Map<string, string>): string[] {
  return [...new Set([...expected.keys(), ...actual.keys()])]
    .sort()
    .filter((path) => actual.get(path) !== expected.get(path))
}

const mirrors = (await readDistSkills(REPO_ROOT)).flatMap((skill) => {
  const live = `.agents/skills/${skill.installName}`
  const pristine = `.agents/skills/.ab-pristine/${skill.installName}`
  return [
    [live, skill.files, join(REPO_ROOT, live)] as const,
    [pristine, skill.files, join(REPO_ROOT, pristine)] as const,
  ]
})

function guidance(label: string): string {
  return `${label} must be synchronized to the canonical install form returned by readDistSkills; canonical-skill divergence is not permitted in this repository`
}

describe('vendored canonical skill mirrors', () => {
  test.each(mirrors)('%s carries the canonical file set', async (label, files, root) => {
    const expected = expectedTree(files)
    const actual = await readTree(root)
    expect(sortedPaths(actual), guidance(label)).toEqual(sortedPaths(expected))
  })

  test.each(mirrors)(
    '%s matches the canonical install-ready contents',
    async (label, files, root) => {
      const expected = expectedTree(files)
      const actual = await readTree(root)
      expect(driftedPaths(expected, actual), guidance(label)).toEqual([])
    },
  )
})
