import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upgradeFollowup } from './upgrade-followup'
test('upgrade output explains pinned adoption, installed adoption and opt-out without claiming a runtime changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-upgrade-followup-'))
  const config = '[tickets]\nsource="file"\nreadyState="ready"\n'
  try {
    await writeFile(join(root, 'autobuild.toml'), config)
    expect(await upgradeFollowup(root)).toContain('Skill merges alone do not change that version')
    await writeFile(join(root, 'package.json'), '{"devDependencies":{"@defrex/autobuild":"2.0.0"}}')
    expect(await upgradeFollowup(root)).toContain('once this commit reaches main')
    expect(await upgradeFollowup(root)).toContain('never pushes')
    await writeFile(join(root, 'autobuild.toml'), `${config}\n[upgrade]\nautomatic=false\n`)
    expect(await upgradeFollowup(root)).toContain('upgrades are off')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
