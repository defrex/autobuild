import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '../config/load'

/** Describes future adoption, never claims that a skill merge upgraded a process. */
export async function upgradeFollowup(checkout: string): Promise<string> {
  const config = await loadConfig(join(checkout, 'autobuild.toml'))
  if (!config.upgrade.automatic)
    return 'Automatic dispatcher upgrades are off; restart dispatchers after updating their installation.'
  let manifest: {
    dependencies?: Record<string, unknown>
    devDependencies?: Record<string, unknown>
  } = {}
  try {
    manifest = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const pinned =
    manifest.dependencies?.['@defrex/autobuild'] !== undefined ||
    manifest.devDependencies?.['@defrex/autobuild'] !== undefined
  return pinned
    ? `Dispatchers check every 60 seconds and adopt the pinned version once this commit reaches ${config.baseBranch}. This command never pushes.`
    : 'The dispatcher on this machine checks its original installation every 60 seconds and adopts a changed version automatically. Skill merges alone do not change that version. This command never pushes.'
}
