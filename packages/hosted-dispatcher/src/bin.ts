#!/usr/bin/env bun
import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  distributionManifestPath,
  writePrebuiltDistributionArchive,
} from '@defrex/autobuild/distribution'
import { selectDeploymentPlugins } from './deployment-plugins'
import { defaultStageGitHost, stageGitForDeployment } from './ship-git'
import { ensureDistributionArchiveInTrace, findArchive } from './ship-packed-distribution'
import { restoresInstallIn, shipProviderPlugins } from './ship-provider-plugin'

const USAGE = `Usage:
  ab-hosted-dispatcher pack-distribution [--root DIR]
  ab-hosted-dispatcher ship-deployment [--root DIR] [--dist-dir DIR] [--plugin NAME]...`

function options(args: string[], name: string): string[] {
  return args.flatMap((value, index) => {
    if (value !== name) return []
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`${name} requires a value`)
    return [next]
  })
}

function option(args: string[], name: string): string | undefined {
  const values = options(args, name)
  if (values.length > 1) throw new Error(`${name} may only be supplied once`)
  return values[0]
}

/** Reject anything that is not the command or one of its `--name value`
 * pairs. */
function rejectUnknown(args: string[], command: string, names: string[]): void {
  if (args[0] !== command) throw new Error(`unknown argument: ${args[0] ?? '(none)'}`)
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!
    if (!names.includes(arg)) throw new Error(`unknown argument: ${arg}`)
    index++
  }
}

/** `pack-distribution`: pack the running distribution into
 * `<root>/.autobuild-dist/autobuild-<version>.tgz` for a deployment whose
 * runtime has neither `bun` nor a source tree (the hosted service on Vercel).
 * Run it in the deployment's build step; the archive is what guests install. */
export async function runPackDistribution(
  args: string[],
  write: (text: string) => void = (text) => console.log(text),
  writeError: (text: string) => void = (text) => console.error(text),
): Promise<number> {
  try {
    const root = option(args, '--root')
    rejectUnknown(args, 'pack-distribution', ['--root'])
    const path = await writePrebuiltDistributionArchive(root)
    write(path)
    return 0
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    return 2
  }
}

export interface ShipDeploymentArguments {
  root: string
  distDir: string
  plugins: string[]
}

export function parseShipDeployment(args: string[], cwd = process.cwd()): ShipDeploymentArguments {
  const root = option(args, '--root') ?? cwd
  const distDir = option(args, '--dist-dir') ?? '.next'
  const plugins = options(args, '--plugin')
  rejectUnknown(args, 'ship-deployment', ['--root', '--dist-dir', '--plugin'])
  return { root, distDir, plugins }
}

/** The packed archive must be the running distribution's version: a stale
 * archive would install a different Autobuild into guests. */
export async function assertArchiveMatchesDistribution(
  archive: string,
  manifest = distributionManifestPath(),
): Promise<void> {
  const archived = /^autobuild-(.+)\.tgz$/.exec(basename(archive))?.[1]
  let version: unknown
  try {
    version = (JSON.parse(await readFile(manifest, 'utf8')) as { version?: unknown }).version
  } catch {
    throw new Error(
      `missing distribution manifest ${manifest} — provisioning reads the version from it`,
    )
  }
  if (archived !== version) {
    throw new Error(
      `distribution archive ${basename(archive)} is version ${archived ?? '(unknown)'} but the ` +
        `installed @defrex/autobuild is ${String(version)} — rerun pack-distribution`,
    )
  }
}

/** `ship-deployment`: after `next build`, carry the packed archive, the
 * distribution manifest, a self-contained `linux-x64` Git for kernel node
 * operations, and the selected provider plugins into the `/api/dispatch`
 * function bundle. */
export async function runShipDeployment(
  args: string[],
  write: (text: string) => void = (text) => console.log(text),
  writeError: (text: string) => void = (text) => console.error(text),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  let parsed: ShipDeploymentArguments
  try {
    parsed = parseShipDeployment(args)
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    return 2
  }
  try {
    await assertArchiveMatchesDistribution(await findArchive(parsed.root))
    await ensureDistributionArchiveInTrace({
      root: parsed.root,
      distDir: parsed.distDir,
      log: write,
    })
    await stageGitForDeployment({
      root: parsed.root,
      distDir: parsed.distDir,
      host: defaultStageGitHost(env),
      log: write,
    })
    const selection = await selectDeploymentPlugins(parsed.root, parsed.plugins)
    write(
      selection.packages.length === 0
        ? 'no provider plugins selected'
        : `provider plugins (${selection.rule}): ${selection.packages.join(', ')}`,
    )
    await shipProviderPlugins({
      cwd: parsed.root,
      distDir: parsed.distDir,
      packages: selection.packages,
      rule: selection.rule,
      restoreInstall: restoresInstallIn(env),
      log: write,
    })
    return 0
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === 'pack-distribution') {
    process.exitCode = await runPackDistribution(args)
  } else if (args[0] === 'ship-deployment') {
    process.exitCode = await runShipDeployment(args)
  } else {
    console.error(`unknown command: ${args[0] ?? '(none)'}\n${USAGE}`)
    process.exitCode = 2
  }
}
