import { captureRuntimeIdentity } from '../runtime-identity'
import { withSourceExport, sourceContent } from './dispatch-upgrade-source'
import { mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cachedRuntime,
  validateRuntime,
  prepareRuntime,
  type CachedRuntime,
} from './dispatch-runtime-cache'
import { readDistributionIdentity, lockPackageRecord } from './installation'
import { reserveExistingRuntime, releasePreparedRuntime } from './dispatch-runtime-use'
import {
  DISPATCH_LAUNCH_VERSION,
  DISPATCH_GENERATION_ENV,
  generationArguments,
} from './dispatch-launch-contract'
import type { UpgradeTarget } from './dispatch-upgrade-target'

/** Compare the staging lock receipt with the previously validated base lock.
 * Registry records carry a URL at index 1; forge records carry dependency
 * metadata there and identify their source by resolution and Bun tag instead. */
export function validateUpgradeLockReceipt(
  authoritative: unknown[],
  received: unknown[] | undefined,
): void {
  if (!received || received[0] !== authoritative[0])
    throw new Error('installed package contradicts authoritative lock')
  if (String(authoritative[0]).includes('@github:')) {
    if (received[2] !== authoritative[2])
      throw new Error('installed forge identity contradicts authoritative lock')
    return
  }
  if (received[1] !== authoritative[1])
    throw new Error('installed package contradicts authoritative lock')
  const integrity = authoritative.at(-1)
  if (typeof integrity === 'string' && integrity.startsWith('sha') && received.at(-1) !== integrity)
    throw new Error('installed integrity contradicts authoritative lock')
}

export async function prepareUpgrade(input: {
  target: UpgradeTarget
  checkout: string
  signal: AbortSignal
  env: Record<string, string | undefined>
}): Promise<CachedRuntime> {
  const { target, checkout, signal } = input
  signal.throwIfAborted()
  const validate = async (runtime: CachedRuntime) => {
    const contract = await readFile(
      join(runtime.root, 'packages/core/src/cli/dispatch-launch-contract.ts'),
      'utf8',
    )
    if (!new RegExp(`DISPATCH_LAUNCH_VERSION = ${DISPATCH_LAUNCH_VERSION}\\b`).test(contract))
      throw new Error('launcher contract changed; manual restart required')
    if (!contract.includes('DISPATCH_OVERLAP_VERSION = 1'))
      throw new Error('target lacks validated overlap preflight; manual restart required')
    await readFile(join(runtime.root, 'packages/core/src/cli/dispatch-handoff.ts'), 'utf8').catch(
      () => {
        throw new Error('target lacks durable handoff support; manual restart required')
      },
    )
    const probe = Bun.spawn(
      [process.execPath, ...generationArguments(runtime.root, ['--read-handoff', 'dispatch'])],
      {
        cwd: checkout,
        env: {
          ...input.env,
          [DISPATCH_GENERATION_ENV]: JSON.stringify({
            version: DISPATCH_LAUNCH_VERSION,
            runtimeRoot: runtime.root,
            checkout,
          }),
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      },
    )
    const [code, output] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ])
    let receipt: { version?: number; handoff?: unknown }
    try {
      receipt = JSON.parse(output)
    } catch {
      throw new Error('target generation handoff reader validation failed')
    }
    if (code !== 0 || receipt.version !== DISPATCH_LAUNCH_VERSION || receipt.handoff !== null)
      throw new Error('target generation handoff reader is incompatible; manual restart required')
    return runtime
  }
  const cache = join(checkout, '.autobuild/runtime')
  // Cached targets retain their authoritative lock fingerprint, without registry credentials.
  if (target.mode === 'pinned' || target.mode === 'source') {
    for (const name of await readdir(cache).catch(() => [] as string[])) {
      let key: string
      try {
        if (target.mode === 'source') {
          const receipt = JSON.parse(
            await readFile(join(cache, name, 'source-receipt.json'), 'utf8'),
          )
          if (receipt.commit !== target.sha) continue
          key = receipt.upgradeKey
        } else key = await readFile(join(cache, name, 'upgrade-key'), 'utf8')
      } catch {
        continue
      }
      if (key !== target.key) continue
      const runtime = await cachedRuntime(join(cache, name, 'distribution'))
      if (!runtime || !reserveExistingRuntime(runtime.root)) continue
      try {
        await validateRuntime(runtime)
        if (target.mode === 'source' && captureRuntimeIdentity(runtime.root).commit !== target.sha)
          throw new Error('cached source runtime commit contradicts target')
        signal.throwIfAborted()
        return await validate(runtime)
      } catch (error) {
        releasePreparedRuntime(runtime.root)
        throw error
      }
    }
  }
  if (target.mode === 'source') {
    return withSourceExport({ checkout, sha: target.sha!, signal }, async (root) => {
      const content = await sourceContent(root, target.source, signal)
      if (content.key !== target.key) throw new Error('source target changed during preparation')
      // Require a committed lock explicitly: frozen-lockfile alone permits a missing lock.
      await readFile(join(root, 'bun.lock'))
      const child = Bun.spawn(
        [process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts', '--no-progress'],
        {
          cwd: root,
          env: input.env,
          stdout: 'ignore',
          stderr: 'pipe',
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        },
      )
      const [code] = await Promise.all([child.exited, new Response(child.stderr).text()])
      signal.throwIfAborted()
      if (code !== 0) throw new Error('source dependency installation failed')
      const path = join(root, 'package.json')
      const manifest = JSON.parse(await readFile(path, 'utf8'))
      manifest.gitHead = target.sha
      await writeFile(path, JSON.stringify(manifest))
      let runtime: CachedRuntime | undefined
      try {
        runtime = await prepareRuntime(root, checkout, {
          upgradeKey: target.key,
          commit: target.sha!,
        })
        if (captureRuntimeIdentity(runtime.root).commit !== target.sha)
          throw new Error('source runtime commit contradicts target')
        signal.throwIfAborted()
        return await validate(runtime)
      } catch (error) {
        if (runtime) releasePreparedRuntime(runtime.root)
        throw error
      }
    })
  }
  if (target.mode === 'installed') {
    const identity = await readDistributionIdentity(target.installRoot!)
    if (identity.version !== target.version)
      throw new Error('original installation changed during preparation')
    const runtime = await prepareRuntime(identity.root, checkout)
    try {
      signal.throwIfAborted()
      return await validate(runtime)
    } catch (error) {
      releasePreparedRuntime(runtime.root)
      throw error
    }
  }
  const owner = await mkdtemp(join(tmpdir(), 'ab-upgrade-'))
  let runtime: CachedRuntime | undefined
  try {
    const name = '@defrex/autobuild'
    const locked = String(target.record![0]).slice(`${name}@`.length)
    await writeFile(
      join(owner, 'package.json'),
      JSON.stringify({ private: true, dependencies: { [name]: locked } }),
    )
    for (const config of ['.npmrc', 'bunfig.toml']) {
      try {
        await copyFile(join(checkout, config), join(owner, config))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const child = Bun.spawn([process.execPath, 'install', '--ignore-scripts', '--no-progress'], {
      cwd: owner,
      env: input.env,
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const abort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 120_000)
    try {
      // Installer diagnostics can contain registry credentials. Only emit a classified error.
      const drain = new Response(child.stderr).text()
      const code = await child.exited
      const diagnostic = await drain
      signal.throwIfAborted()
      if (code !== 0) {
        const reason = /401|403|unauthorized|forbidden/i.test(diagnostic)
          ? 'registry authentication failed'
          : /404|no version matching|not found/i.test(diagnostic)
            ? 'target package version is unavailable'
            : /ENOTFOUND|ECONN|unable to connect|connection refused/i.test(diagnostic)
              ? 'registry is unreachable'
              : /integrity|checksum/i.test(diagnostic)
                ? 'package integrity validation failed'
                : `target package installation failed (status ${code})`
        throw new Error(reason)
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const installed = await readDistributionIdentity(join(owner, 'node_modules', name))
    const generated = Bun.JSONC.parse(await readFile(join(owner, 'bun.lock'), 'utf8')) as Record<
      string,
      unknown
    >
    const record = lockPackageRecord(generated, name)
    // The generated lock is only a receipt for the previously validated authoritative record.
    validateUpgradeLockReceipt(target.record!, record)
    if (target.version !== undefined && installed.version !== target.version)
      throw new Error('installed version contradicts target')
    runtime = await prepareRuntime(installed.root, checkout)
    await validate(runtime)
    signal.throwIfAborted()
    await writeFile(join(cache, runtime.id, 'upgrade-key'), target.key)
    return runtime
  } catch (error) {
    if (runtime) releasePreparedRuntime(runtime.root)
    throw error
  } finally {
    await rm(owner, { recursive: true, force: true })
  }
}
