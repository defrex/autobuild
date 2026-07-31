import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this file so a check runs from any cwd. */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Every tracked path, repo-root-relative. Rejecting is fatal to its callers: a
 * check that cannot enumerate must never report a clean tree.
 */
export const gitTrackedPaths = async (): Promise<readonly string[]> => {
  const processHandle = Bun.spawn(['git', 'ls-files', '-z'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`git ls-files exited with status ${exitCode}: ${stderr.trim()}`)
  }
  return stdout.split('\0').filter((path) => path.length > 0)
}
