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
  if (target.mode === 'pinned') {
    for (const name of await readdir(cache).catch(() => [] as string[])) {
      let key: string
      try {
        key = await readFile(join(cache, name, 'upgrade-key'), 'utf8')
      } catch {
        continue
      }
      if (key !== target.key) continue
      const runtime = await cachedRuntime(join(cache, name, 'distribution'))
      if (!runtime || !reserveExistingRuntime(runtime.root)) continue
      try {
        await validateRuntime(runtime)
        signal.throwIfAborted()
        return await validate(runtime)
      } catch (error) {
        releasePreparedRuntime(runtime.root)
        throw error
      }
    }
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
    if (!record || record[0] !== target.record![0] || record[1] !== target.record![1])
      throw new Error('installed package contradicts authoritative lock')
    if (target.version !== undefined && installed.version !== target.version)
      throw new Error('installed version contradicts target')
    // The generated lock is only a receipt for checking the previously validated authoritative record.
    const integrity = target.record!.at(-1)
    if (typeof integrity === 'string' && integrity.startsWith('sha') && record.at(-1) !== integrity)
      throw new Error('installed integrity contradicts authoritative lock')
    if (target.record![0]!.toString().includes('@github:') && record[2] !== target.record![2])
      throw new Error('installed forge identity contradicts authoritative lock')
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
