import { join, resolve } from 'node:path'

/** Keep provider/authentication code out of the resident launcher's eager graph.
 * The bounded child uses the same authenticated release transport as dispatch. */
export async function fetchRuntimeGuestRelease(
  version: string,
  module = resolve(import.meta.dir, '../ports/workspace/distribution-release.ts'),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Uint8Array> {
  const source = `import { fetchDistributionReleaseAsset } from ${JSON.stringify(module)}; process.stdout.write(await fetchDistributionReleaseAsset(${JSON.stringify(version)}));`
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--tsconfig-override',
      join(import.meta.dir, '../../../../tsconfig.json'),
      '--eval',
      source,
    ],
    {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(60_000),
    },
  )
  const [bytes, diagnostic, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0)
    throw new Error(
      `could not resolve published guest archive for Autobuild ${version}; verify the version's GitHub release asset and credentials (exit ${code})`,
    )
  // Provider diagnostics may carry credentials; never include them in errors.
  void diagnostic
  return bytes
}
