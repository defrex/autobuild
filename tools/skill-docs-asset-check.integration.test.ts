import { describe, expect, test } from 'bun:test'
import {
  findSkillDocsAssetProblems,
  isRepoLocalSkillDoc,
  realEnvironment,
  scanSkillDocsAssets,
  skillDocsAssetMentions,
} from './skill-docs-asset-check'

describe('real repository boundary', () => {
  test('the real tree passes the real check', async () => {
    expect(await scanSkillDocsAssets(realEnvironment)).toEqual([])
  })

  test('inventory-derived scope and extracted asset occurrences produce real diagnostics', async () => {
    const names = await realEnvironment.listCanonicalSkillNames()
    expect(names).toContain('ab-plan')
    expect(names).not.toContain('readme-headline')

    const path = '.agents/skills/readme-headline/SKILL.md'
    expect(isRepoLocalSkillDoc(path, names)).toBe(true)

    const contents = await realEnvironment.readTextFile(path)
    expect(skillDocsAssetMentions({ path, contents })).toEqual([
      { target: 'docs/assets/headline-wide.png', resolved: 'docs/assets/headline-wide.png' },
      { target: 'docs/assets/headline-wide.png', resolved: 'docs/assets/headline-wide.png' },
    ])

    const findings = findSkillDocsAssetProblems([], [{ path, contents }])

    expect(findings).toEqual([
      {
        kind: 'broken',
        document: path,
        target: 'docs/assets/headline-wide.png',
        resolved: 'docs/assets/headline-wide.png',
      },
      {
        kind: 'broken',
        document: path,
        target: 'docs/assets/headline-wide.png',
        resolved: 'docs/assets/headline-wide.png',
      },
    ])
  })
})
