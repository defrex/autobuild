/** Maintainer-only foreground entry. No process management lives here. */
import { realpath } from 'node:fs/promises'
import { canonicalRoot, capture, command } from './dispatcher-check'

export async function launch(
  args: string[],
  prepare: () => Promise<void>,
  load: () => Promise<(args: string[]) => Promise<number>>,
): Promise<number> {
  await prepare()
  const run = await load()
  return run(['dispatch', ...args])
}

export async function prepareLaunch(directory: string): Promise<void> {
  const cwd = await realpath(directory)
  const root = await canonicalRoot(cwd)
  if (
    cwd !== root ||
    (await command(root, ['git', 'symbolic-ref', '--short', 'HEAD'])) !== 'main'
  ) {
    throw new Error('Run this maintainer entry from the canonical repository root on main')
  }
  await capture(root)
}

if (import.meta.main) {
  process.exit(
    await launch(
      process.argv.slice(2),
      async () => {
        await prepareLaunch(process.cwd())
      },
      async () => (await import('../packages/core/src/cli/binary')).runBinary,
    ),
  )
}
