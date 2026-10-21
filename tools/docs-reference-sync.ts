import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readDistSkills } from '../packages/core/src/cli/init'

/** Complete-byte parity for the public sources also delivered in the guide install tree. */
export async function checkDocsReferences(
  root = resolve(import.meta.dir, '..'),
): Promise<string[]> {
  const names = (await readdir(join(root, 'docs'))).filter((name) => name.endsWith('.md')).sort()
  const guide = (await readDistSkills(root)).find((skill) => skill.installName === 'ab-guide')
  if (!guide) throw new Error('Missing canonical ab-guide inventory')
  const findings: string[] = []
  for (const name of names) {
    const file = guide.files.find((file) => file.path === `references/${name}`)
    if (!file) continue
    const source = `docs/${name}`
    const expected = await readFile(join(root, source))
    for (const target of [
      `skills/guide/references/${name}`,
      `.agents/skills/ab-guide/references/${name}`,
      `.agents/skills/.ab-pristine/ab-guide/references/${name}`,
    ]) {
      try {
        if (!expected.equals(await readFile(join(root, target))))
          findings.push(`${source} differs from ${target}`)
      } catch (error) {
        findings.push(`${source} cannot compare ${target}: ${String(error)}`)
      }
    }
  }
  return findings
}

if (import.meta.main) {
  try {
    const findings = await checkDocsReferences()
    if (findings.length) {
      console.error(findings.join('\n'))
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`Cannot check docs/reference parity: ${String(error)}`)
    process.exitCode = 1
  }
}
