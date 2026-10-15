#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
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

/** Resolve from the consumer, never this package's development workspace. A
 * present package with broken exports is an error, not store-only mode. */
export function deploymentDependencies(root: string) {
  const require = createRequire(join(root, 'package.json'))
  const required = (name: string) => {
    try {
      return Bun.resolveSync(name, root)
    } catch (cause) {
      throw new Error(`Deployment dependency ${name} is required`, { cause })
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
  if (installed) required(`${dispatcherName}/runtime`)
  return { next, migrate: join(dirname(postgres), 'bin.ts'), dispatcher: installed }
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

type Run = (args: string[], root: string) => Promise<void>
const run: Run = async (args, root) => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    env: { ...process.env, AB_SERVICE_BUILD_ROOT: root },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`Deployment command failed (${code}): ${args.join(' ')}`)
}

export async function buildDeployment(root = process.cwd(), execute: Run = run) {
  root = resolve(root)
  const dependencies = deploymentDependencies(root)
  await stageDeployment(root, dependencies.dispatcher)
  await execute([dependencies.migrate, 'migrate'], root)
  try {
    await execute([dependencies.next, 'build'], root)
  } finally {
    // Next owns these generated declarations/config amendments during build.
    // Record its result so subsequent builds still detect later consumer edits.
    const ledger = join(root, ownershipFile)
    const owned = JSON.parse(await readFile(ledger, 'utf8'))
    for (const path of ['tsconfig.json', 'next-env.d.ts'])
      owned[path] = digest(await readFile(join(root, path)))
    await writeFile(ledger, `${JSON.stringify(owned, null, 2)}\n`)
  }
}

if (import.meta.main) {
  try {
    await buildDeployment()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
