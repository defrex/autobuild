import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { withDataServices } from './data-services'
import { runCredentialProof, runCredentialHttpProof } from './protocol-credentials.integration.test'
import { buildProtocolExecutables } from './protocol-server-harness'

const project = resolve(import.meta.dir, '..')
/** Call while holding the experiment's external Cargo cache flock, just like
 * data-integration.ts. This function never acquires another flock. The gate
 * owns locking; this function builds the helper once per run.
 */
export async function buildCredentialHelper(environment: Record<string, string | undefined>) {
  const target = environment.CARGO_TARGET_DIR
  if (!target || !isAbsolute(target))
    throw new Error('Set external absolute CARGO_TARGET_DIR and hold its .verify.lock')
  const cache = realpathSync(target)
  const worktrees = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: project })
  if (worktrees.exitCode)
    throw new Error('Cannot resolve worktree paths for Cargo cache validation')
  for (const match of worktrees.stdout.toString().matchAll(/^worktree (.+)$/gm))
    if (cache === match[1] || cache.startsWith(`${match[1]}/`))
      throw new Error('Cargo cache must be outside every worktree')
  const child = Bun.spawn(
    [
      'cargo',
      'build',
      '--locked',
      '--example',
      'protocol-credential-proof',
      '--message-format=json',
    ],
    {
      cwd: project,
      env: environment,
      stdout: 'pipe',
      stderr: 'inherit',
    },
  )
  const output = await new Response(child.stdout).text()
  const exit = await child.exited
  let executable: string | undefined
  for (const line of output.split('\n').filter(Boolean)) {
    const artifact = JSON.parse(line) as {
      reason?: string
      executable?: string
      target?: { name?: string }
      message?: { rendered?: string }
    }
    if (artifact.reason === 'compiler-message' && artifact.message?.rendered)
      process.stderr.write(artifact.message.rendered)
    if (
      artifact.reason === 'compiler-artifact' &&
      artifact.target?.name === 'protocol-credential-proof' &&
      artifact.executable
    )
      executable = artifact.executable
  }
  if (exit !== 0) throw new Error('Rust credential helper build failed')
  if (!executable) throw new Error('Cargo did not report the credential helper executable')
  return executable
}
if (import.meta.main) {
  const executable = await buildCredentialHelper(process.env)
  const { server } = await buildProtocolExecutables(process.env)
  await withDataServices(async (admin, environment) => {
    await runCredentialProof(executable, admin, environment)
    await runCredentialHttpProof(server, admin, environment)
  })
}
