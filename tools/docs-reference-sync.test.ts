import { expect, test } from 'bun:test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDocsReferences } from './docs-reference-sync'

async function fixture(run: (root: string, copies: string[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'docs-sync-'))
  const copies = [
    'skills/guide/references',
    '.agents/skills/ab-guide/references',
    '.agents/skills/.ab-pristine/ab-guide/references',
  ]
  try {
    await Bun.write(join(root, 'skills/guide/SKILL.md'), '---\nname: ab-guide\n---\n# Guide')
    await Bun.write(join(root, 'docs/shared.md'), '---\ntitle: Shared\n---\nbytes\n')
    for (const copy of copies)
      await Bun.write(join(root, copy, 'shared.md'), '---\ntitle: Shared\n---\nbytes\n')
    await Bun.write(join(root, 'skills/guide/references/plugin-authoring.md'), 'Guide only')
    await run(root, copies)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('discovers overlaps, compares complete bytes and does not require guide-only docs', async () => {
  await fixture(async (root, copies) => {
    expect(await checkDocsReferences(root)).toEqual([])
    for (const copy of copies) {
      await Bun.write(join(root, copy, 'shared.md'), 'bytes\n')
      expect(await checkDocsReferences(root)).toContain(
        `docs/shared.md differs from ${copy}/shared.md`,
      )
      await Bun.write(join(root, copy, 'shared.md'), '---\ntitle: Shared\n---\nbytes\n')
    }
    await Bun.write(join(root, 'docs/new.md'), 'new')
    await Bun.write(join(root, copies[0]!, 'new.md'), 'new')
    expect(await checkDocsReferences(root)).toHaveLength(2)
  })
})

test('missing and unreadable installed copies fail with both filenames', async () => {
  await fixture(async (root, copies) => {
    await rm(join(root, copies[1]!, 'shared.md'))
    await rm(join(root, copies[2]!, 'shared.md'))
    await mkdir(join(root, copies[2]!, 'shared.md'))
    const findings = await checkDocsReferences(root)
    expect(findings).toHaveLength(2)
    expect(
      findings.every(
        (message) =>
          message.includes('docs/shared.md') && message.includes('cannot compare .agents/'),
      ),
    ).toBe(true)
  })
})

test('check script enforces the byte parity guard', async () => {
  const pkg = await Bun.file(join(import.meta.dir, '../package.json')).json()
  expect(pkg.scripts.check.split(' && ')).toContain('bun tools/docs-reference-sync.ts')
  expect(await checkDocsReferences()).toEqual([])
})
