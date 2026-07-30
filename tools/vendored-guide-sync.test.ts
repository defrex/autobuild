/**
 * This repository's vendored `ab-guide` must equal the canonical guide's
 * install form — live tree and `.ab-pristine` alike.
 *
 * This is repository configuration, not product behavior, which is why it
 * lives in `tools/` rather than `src/`. Autobuild's customization contract is
 * that `ab init` copies skills so a consuming repository may edit any of them,
 * and `ab upgrade` three-way merges those edits against `.ab-pristine`. This
 * repository declines that freedom for the guide: it has never customized its
 * installed copy, and the installed copy silently falling behind the canonical
 * one is a real failure mode we have already hit. Nothing here binds anyone
 * else's checkout.
 *
 * The accepted consequence: a change to `skills/guide/` must update both
 * mirrors in the same diff, or `bun test` goes red. That is a mechanical copy;
 * the failure message below names it.
 *
 * Imports nothing from `src/` — this asserts against bytes on disk, so the
 * policy does not couple itself to product internals.
 */
import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

/**
 * A complete remedy for every drift class the tests below detect, including a
 * canonical file that was removed or renamed. It rebuilds each mirror from
 * scratch rather than copying over it: an overlay copy can add and update files
 * but never removes one the canonical tree dropped, which would leave the
 * path-set assertion red after following the advice.
 */
const REMEDY = [
  'rm -rf .agents/skills/ab-guide .agents/skills/.ab-pristine/ab-guide',
  'cp -r skills/guide .agents/skills/ab-guide',
  "sed '0,/^name: guide$/s//name: ab-guide/' skills/guide/SKILL.md > .agents/skills/ab-guide/SKILL.md",
  'cp -r .agents/skills/ab-guide .agents/skills/.ab-pristine/ab-guide',
].join(' && ')

/**
 * Every regular file under `root`, keyed by POSIX path relative to it.
 *
 * Reads the directory rather than taking the file list from `readDistSkills`:
 * a guard built on that function would silently narrow to `SKILL.md` and keep
 * passing if it ever stopped returning `references/`. Reading the tree cannot
 * narrow.
 */
async function readTree(root: string, prefix = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const entry of await readdir(join(root, ...prefix.split('/').filter(Boolean)), {
    withFileTypes: true,
  })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      for (const [nested, content] of await readTree(root, path)) files.set(nested, content)
    } else if (entry.isFile()) {
      files.set(path, await readFile(join(root, ...path.split('/')), 'utf8'))
    }
  }
  return files
}

const canonical = await readTree(join(REPO_ROOT, 'skills', 'guide'))
const live = await readTree(join(REPO_ROOT, '.agents', 'skills', 'ab-guide'))
const pristine = await readTree(join(REPO_ROOT, '.agents', 'skills', '.ab-pristine', 'ab-guide'))

/**
 * Hand-derived rather than routed through `rewriteSkillSource`: a change to
 * the install transform must be restated here deliberately instead of silently
 * redefining what the checked-in mirrors are compared against. `guide` is in
 * `MODEL_INVOCABLE_SKILLS`, so unlike the review skills its install form adds
 * no `disable-model-invocation:` line — the whole transform is the rename.
 */
function installForm(source: string): string {
  return source.replace('\nname: guide\n', '\nname: ab-guide\n')
}

/** The canonical tree as it should appear once installed. */
function expectedTree(): Map<string, string> {
  return new Map(
    [...canonical].map(([path, content]) => [
      path,
      path === 'SKILL.md' ? installForm(content) : content,
    ]),
  )
}

function sortedPaths(tree: Map<string, string>): string[] {
  return [...tree.keys()].sort()
}

function driftedPaths(expected: Map<string, string>, actual: Map<string, string>): string[] {
  return sortedPaths(expected).filter((path) => actual.get(path) !== expected.get(path))
}

const mirrors = [
  ['.agents/skills/ab-guide', live],
  ['.agents/skills/.ab-pristine/ab-guide', pristine],
] as const

describe('vendored ab-guide mirrors', () => {
  test('the install transform renames the skill', () => {
    // Without this, a rename that silently stopped matching would leave both
    // comparisons below asserting against unrewritten canonical bytes.
    const skill = canonical.get('SKILL.md')
    expect(skill, 'skills/guide/SKILL.md is missing').toBeDefined()
    expect(installForm(skill ?? '')).not.toBe(skill)
  })

  test.each(mirrors)('%s carries the canonical file set', (label, mirror) => {
    // Compared first, so an added, removed, or renamed file is reported as a
    // path rather than surfacing as a content mismatch.
    expect(
      sortedPaths(mirror),
      `${label} has the wrong files — re-run the canonical → vendored sync:\n${REMEDY}`,
    ).toEqual(sortedPaths(expectedTree()))
  })

  test.each(mirrors)('%s matches the canonical install form', (label, mirror) => {
    const drifted = driftedPaths(expectedTree(), mirror)
    expect(drifted, `${label} is stale — re-run the canonical → vendored sync:\n${REMEDY}`).toEqual(
      [],
    )
  })
})
