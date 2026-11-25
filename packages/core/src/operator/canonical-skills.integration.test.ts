import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HELP_CATALOG } from '../cli/help'
import { defaultCanonicalSkills } from './canonical-skills'
import { cliMentions } from './cli-equivalents'

const ROOT = join(import.meta.dir, '..', '..', '..', '..')

test('the canonical bundle is the install form ab init vendors', async () => {
  const bundle = await defaultCanonicalSkills()
  const operate = bundle.skills.find((skill) => skill.installName === 'ab-operate')!
  const skill = operate.files.find((file) => file.path === 'SKILL.md')!
  expect(skill.content).toBe(
    await readFile(join(ROOT, '.agents/skills/.ab-pristine/ab-operate/SKILL.md'), 'utf8'),
  )
})

test('every ab command a canonical skill mentions has a preamble line', async () => {
  const catalog = new Set(HELP_CATALOG.map((entry) => entry.name))
  const unresolved: string[] = []
  for (const skill of (await defaultCanonicalSkills()).skills)
    for (const file of skill.files) {
      if (!file.path.endsWith('.md')) continue
      for (const match of file.content.matchAll(/(?<![\w./-])ab ([a-z][a-z-]*(?: [a-z][a-z-]*)*)/g))
        if (catalog.has(match[1]!.split(' ')[0]!) && cliMentions(match[0]).length !== 1)
          unresolved.push(`${skill.installName}/${file.path}: ${match[0]}`)
    }
  expect(unresolved).toEqual([])
})
