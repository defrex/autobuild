#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dir, '..')
const ownershipFile = '.autobuild-service-assets.json'
const unavailableRoute = `export const dynamic = 'force-dynamic'
export function GET() {
  return Response.json({ error: 'dispatch runs elsewhere for this deployment' }, { status: 503 })
}
`
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** The output-file-tracing root for a deployment folder: the nearest
 * ancestor whose `package.json` `workspaces` matches the folder (a Bun
 * workspace member installs its dependencies at that root), else the folder
 * itself. */
export function deploymentTraceRoot(root: string): string {
  root = resolve(root)
  let ancestor = dirname(root)
  while (true) {
    const manifest = join(ancestor, 'package.json')
    if (existsSync(manifest)) {
      let workspaces: unknown
      try {
        workspaces = JSON.parse(readFileSync(manifest, 'utf8')).workspaces
      } catch {
        workspaces = undefined
      }
      const patterns = Array.isArray(workspaces)
        ? workspaces
        : (workspaces as { packages?: unknown } | undefined)?.packages
      const member = relative(ancestor, root).replaceAll('\\', '/')
      if (
        Array.isArray(patterns) &&
        patterns.some(
          (pattern) =>
            typeof pattern === 'string' && new Bun.Glob(pattern.replace(/\/+$/, '')).match(member),
        )
      )
        return ancestor
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return root
    ancestor = parent
  }
}

/** Resolve from the consumer, never this package's development workspace. A
 * present package with broken exports is an error, not store-only mode. */
export function deploymentDependencies(root: string) {
  const require = createRequire(join(root, 'package.json'))
  const required = (name: string, message = `Deployment dependency ${name} is required`) => {
    try {
      return Bun.resolveSync(name, root)
    } catch (cause) {
      throw new Error(message, { cause })
    }
  }
  const next = required('next/dist/bin/next')
  // Bun's isolated linker may keep this declared dependency private to the service.
  const postgres = Bun.resolveSync('@defrex/autobuild-postgres-store', packageRoot)
  // Resolve the package identity separately from its runtime export. This
  // distinguishes absence from an installed but malformed/broken dispatcher.
  const dispatcherName = '@defrex/autobuild-hosted-dispatcher'
  const installed =
    require.resolve.paths(dispatcherName)?.some((path) => existsSync(join(path, dispatcherName))) ??
    false
  let dispatcherBin: string | undefined
  if (installed) {
    required(`${dispatcherName}/runtime`)
    dispatcherBin = required(
      `${dispatcherName}/bin`,
      `installed ${dispatcherName} lacks the deploy bin; install the version matching @defrex/autobuild-hosted-store-service`,
    )
  }
  const traceRoot = deploymentTraceRoot(root)
  for (const [name, path] of [
    ['next', next],
    [dispatcherName, dispatcherBin],
  ] as const) {
    if (
      path !== undefined &&
      relative(realpathSync(traceRoot), realpathSync(path)).startsWith('..')
    )
      throw new Error(
        `Deployment dependency ${name} is installed outside the tracing root ${traceRoot}`,
      )
  }
  return {
    next,
    migrate: join(dirname(postgres), 'bin.ts'),
    dispatcher: installed,
    dispatcherBin,
    traceRoot,
  }
}

/** Stage only owned assets. Hashes prevent a later build overwriting edits to
 * generated files, and the entire collision check precedes any mutation. */
export async function stageDeployment(root: string, dispatcher: boolean, source = packageRoot) {
  const files = new Map<string, Uint8Array>()
  async function collect(path: string) {
    for (const entry of await readdir(join(source, path), { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await collect(child)
      else if (!/\.(?:test|spec)\.tsx?$/.test(child))
        files.set(child, await readFile(join(source, child)))
    }
  }
  await collect('app')
  for (const path of ['next.config.ts', 'next-env.d.ts'])
    files.set(path, await readFile(join(source, path)))
  files.set('tsconfig.json', await readFile(join(source, 'tsconfig.deploy.json')))
  if (!dispatcher) files.set('app/api/dispatch/route.ts', Buffer.from(unavailableRoute))
  let previous: Record<string, string> = {}
  const ledger = join(root, ownershipFile)
  if (existsSync(ledger)) previous = JSON.parse(await readFile(ledger, 'utf8'))
  for (const path of new Set([...Object.keys(previous), ...files.keys()])) {
    if (relative(root, resolve(root, path)).startsWith('..') || resolve(root, path) === root)
      throw new Error('Invalid generated asset path')
    if (existsSync(join(root, path))) {
      if (!previous[path] || digest(await readFile(join(root, path))) !== previous[path]) {
        throw new Error(`Refusing to overwrite consumer-owned file: ${path}`)
      }
    }
  }
  for (const path of Object.keys(previous))
    if (!files.has(path)) await rm(join(root, path), { force: true })
  const owned: Record<string, string> = {}
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), bytes)
    owned[path] = digest(bytes)
  }
  await writeFile(ledger, `${JSON.stringify(owned, null, 2)}\n`)
}

type Run = (args: string[], root: string, env: Record<string, string>) => Promise<void>
const run: Run = async (args, root, env) => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`Deployment command failed (${code}): ${args.join(' ')}`)
}

/** Stage, migrate and build. With the dispatcher installed, also pack the
 * guest distribution before the build and ship it, the distribution manifest
 * and the selected provider plugins into `/api/dispatch` after it. */
export async function buildDeployment(root = process.cwd(), execute: Run = run) {
  root = resolve(root)
  const dependencies = deploymentDependencies(root)
  const env = { AB_SERVICE_BUILD_ROOT: dependencies.traceRoot }
  await stageDeployment(root, dependencies.dispatcher)
  if (dependencies.dispatcherBin)
    await execute([dependencies.dispatcherBin, 'pack-distribution', '--root', root], root, env)
  await execute([dependencies.migrate, 'migrate'], root, env)
  try {
    await execute([dependencies.next, 'build'], root, env)
  } finally {
    // Next owns these generated declarations/config amendments during build.
    // Record its result so subsequent builds still detect later consumer edits.
    const ledger = join(root, ownershipFile)
    const owned = JSON.parse(await readFile(ledger, 'utf8'))
    for (const path of ['tsconfig.json', 'next-env.d.ts'])
      owned[path] = digest(await readFile(join(root, path)))
    await writeFile(ledger, `${JSON.stringify(owned, null, 2)}\n`)
  }
  if (dependencies.dispatcherBin)
    await execute([dependencies.dispatcherBin, 'ship-deployment', '--root', root], root, env)
}

if (import.meta.main) {
  try {
    await buildDeployment()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
