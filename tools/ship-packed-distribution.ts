#!/usr/bin/env bun
/**
 * Guarantee the packaged guest distribution ships in the hosted deployment.
 *
 * Next 16's default Turbopack builds never apply `outputFileTracingIncludes`
 * (see docs/hosted-dispatcher.md), so a `next build` alone cannot be relied on
 * to carry `.autobuild-dist/autobuild-<version>.tgz` into the `/api/dispatch`
 * function bundle. This post-build step appends the archive to the dispatch
 * route's `route.js.nft.json` — the trace file Vercel's Next builder consumes
 * when assembling the function bundle — computing the entry exactly the way
 * Next itself computes `outputFileTracingIncludes` entries (relative from the
 * trace file's directory). It fails loudly when pack-distribution has not run
 * or the trace file is missing, so a deployment can never silently ship
 * without the archive.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

export interface EnsureOptions {
  root?: string
  distDir?: string
  log?: (message: string) => void
}

export interface EnsureResult {
  archive: string
  bytes: number
  sha256: string
  appended: boolean
}

const DIST_DIRECTORY = '.autobuild-dist'
const TRACE_FILE = 'route.js.nft.json'
const ROUTE_DIRECTORY = join('server', 'app', 'api', 'dispatch')

async function findArchive(root: string): Promise<string> {
  const dist = join(root, DIST_DIRECTORY)
  let entries: string[]
  try {
    entries = await readdir(dist)
  } catch {
    throw new Error(
      `no ${DIST_DIRECTORY}/ directory under ${root} — run ` +
        '`bun packages/hosted-store-service/src/bin.ts pack-distribution` before building',
    )
  }
  const archives = entries.filter((name) => /^autobuild-.+\.tgz$/.test(name)).sort()
  if (archives.length === 0) {
    throw new Error(
      `no autobuild-*.tgz in ${DIST_DIRECTORY}/ — run ` +
        '`bun packages/hosted-store-service/src/bin.ts pack-distribution` before building',
    )
  }
  if (archives.length > 1) {
    throw new Error(
      `expected exactly one archive in ${DIST_DIRECTORY}/, found ${archives.length}: ` +
        `${archives.join(', ')} — rerun pack-distribution to remove stale archives`,
    )
  }
  return join(dist, archives[0]!)
}

function tracePath(root: string, distDir: string): string {
  return join(root, distDir, ROUTE_DIRECTORY, TRACE_FILE)
}

async function readTrace(path: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(
      `missing Next.js trace file ${path} — run this tool after \`next build\`; ` +
        'if the dispatch route was renamed, update tools/ship-packed-distribution.ts',
    )
  }
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { files?: unknown }).files)
  ) {
    throw new Error(`unexpected trace file layout in ${path}: "files" array not found`)
  }
  return (parsed as { files: string[] }).files
}

/** Append the packed distribution archive to the dispatch route's trace file. */
export async function ensureDistributionArchiveInTrace({
  root = process.cwd(),
  distDir = '.next',
  log = (message) => console.log(message),
}: EnsureOptions = {}): Promise<EnsureResult> {
  const archive = await findArchive(root)
  const trace = tracePath(root, distDir)
  const files = await readTrace(trace)

  const entry = relative(dirname(trace), archive)
  const appended = !files.includes(entry)
  if (appended) {
    const parsed = JSON.parse(await readFile(trace, 'utf8'))
    await writeFile(trace, `${JSON.stringify({ ...parsed, files: [...files, entry] }, null, 2)}\n`)
  }

  const bytes = (await stat(archive)).size
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  log(
    `distribution archive ${basename(archive)} (${bytes} bytes, sha256 ${sha256}) ` +
      `${appended ? 'appended to' : 'already present in'} ${trace}`,
  )
  return { archive, bytes, sha256, appended }
}

if (import.meta.main) {
  try {
    await ensureDistributionArchiveInTrace()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
