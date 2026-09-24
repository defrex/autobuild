#!/usr/bin/env bun
/**
 * Guarantee the packaged guest distribution and the canonical operate skill
 * ship in the hosted deployment.
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
 *
 * It appends the distribution manifest the same way. Provisioning reads the
 * running version from the repository root's package.json, which no import
 * traces; it reached the bundle only while the Next.js project directory was
 * the repository root, and a Root Directory below it drops the file.
 *
 * It also appends `skills/operate/SKILL.md` — the canonical `ab-operate`
 * skill the embedded orchestrator reads at runtime through
 * `distributionPath` (AUT-342) — to BOTH function bundles that execute
 * turns: the operator route's trace (message and answer invocations run
 * there) and the dispatch route's trace (the tick's resume and wake passes
 * run the turn loop inside `/api/dispatch`, which otherwise traces only
 * `.autobuild-dist/**`). A dynamic fs read is invisible to tracing, so
 * without these appends the system prompt could not load in production while
 * every in-process test passed. Both entries are computed the same relative
 * way, and the step fails loudly when a trace file or the skill file is
 * missing — a deployment can never silently ship without the skill.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { distributionManifestPath, distributionPath } from '@defrex/autobuild/distribution'

export interface EnsureOptions {
  root?: string
  distDir?: string
  /** Distribution manifest to carry; defaults to the file provisioning reads. */
  manifest?: string
  /** Canonical operate skill to carry; defaults to the distribution tree the
   * turn runner reads at runtime. */
  skill?: string
  log?: (message: string) => void
}

export interface EnsureResult {
  archive: string
  bytes: number
  sha256: string
  appended: boolean
  manifestAppended: boolean
  /** The canonical operate skill file carried into the turn-executing bundles. */
  skill: string
  /** Route names whose trace got the skill appended ('dispatch', 'operator'). */
  skillAppended: string[]
}

const DIST_DIRECTORY = '.autobuild-dist'
const TRACE_FILE = 'route.js.nft.json'
const ROUTE_DIRECTORY = join('server', 'app', 'api', 'dispatch')
/** The operator route — message and approval-answer invocations run turns
 * inside this function bundle. */
const OPERATOR_ROUTE_DIRECTORY = join('server', 'app', 'operator', '[[...path]]')

async function findArchive(root: string): Promise<string> {
  const dist = join(root, DIST_DIRECTORY)
  let entries: string[]
  try {
    entries = await readdir(dist)
  } catch {
    throw new Error(
      `no ${DIST_DIRECTORY}/ directory under ${root} — run ` +
        '`bun ../../packages/hosted-dispatcher/src/bin.ts pack-distribution --root .` before building',
    )
  }
  const archives = entries.filter((name) => /^autobuild-.+\.tgz$/.test(name)).sort()
  if (archives.length === 0) {
    throw new Error(
      `no autobuild-*.tgz in ${DIST_DIRECTORY}/ — run ` +
        '`bun ../../packages/hosted-dispatcher/src/bin.ts pack-distribution --root .` before building',
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

async function readTrace(path: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(
      `missing Next.js trace file ${path} — run this tool after \`next build\`; ` +
        'if the dispatch route was renamed, update packages/hosted-dispatcher/src/ship-packed-distribution.ts',
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

/** Append the packed distribution archive and the canonical operate skill to
 * the turn-executing routes' trace files. */
export async function ensureDistributionArchiveInTrace({
  root = process.cwd(),
  distDir = '.next',
  manifest = distributionManifestPath(),
  skill = distributionPath('skills', 'operate', 'SKILL.md'),
  log = (message) => console.log(message),
}: EnsureOptions = {}): Promise<EnsureResult> {
  const archive = await findArchive(root)
  try {
    await stat(manifest)
  } catch {
    throw new Error(
      `missing distribution manifest ${manifest} — provisioning reads the version from it`,
    )
  }
  try {
    await stat(skill)
  } catch {
    throw new Error(
      `missing canonical operate skill ${skill} — the orchestrator's system prompt ` +
        'cannot load in production without it',
    )
  }
  const routes = [
    { name: 'dispatch', directory: ROUTE_DIRECTORY },
    { name: 'operator', directory: OPERATOR_ROUTE_DIRECTORY },
  ]
  const skillAppended: string[] = []
  let appended = false
  let manifestAppended = false
  for (const route of routes) {
    const trace = join(root, distDir, route.directory, TRACE_FILE)
    const files = await readTrace(trace)

    const entry = relative(dirname(trace), archive)
    const manifestEntry = relative(dirname(trace), manifest)
    const skillEntry = relative(dirname(trace), skill)
    const appendedHere = !files.includes(entry)
    const manifestAppendedHere = !files.includes(manifestEntry)
    const skillMissing = !files.includes(skillEntry)
    if (skillMissing) skillAppended.push(route.name)
    if (appendedHere || manifestAppendedHere || skillMissing) {
      const parsed = JSON.parse(await readFile(trace, 'utf8'))
      const added = [
        ...(appendedHere ? [entry] : []),
        ...(manifestAppendedHere ? [manifestEntry] : []),
        ...(skillMissing ? [skillEntry] : []),
      ]
      await writeFile(
        trace,
        `${JSON.stringify({ ...parsed, files: [...files, ...added] }, null, 2)}\n`,
      )
    }

    if (route.name === 'dispatch') {
      appended = appended || appendedHere
      manifestAppended = manifestAppended || manifestAppendedHere
      const bytes = (await stat(archive)).size
      const sha256 = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex')
      log(
        `distribution archive ${basename(archive)} (${bytes} bytes, sha256 ${sha256}) ` +
          `${appendedHere ? 'appended to' : 'already present in'} ${trace}`,
      )
      log(
        `distribution manifest ${manifest} ` +
          `${manifestAppendedHere ? 'appended to' : 'already present in'} ${trace}`,
      )
    }
    log(
      `operate skill ${basename(skill)} ` +
        `${skillMissing ? 'appended to' : 'already present in'} ${trace}`,
    )
  }
  return {
    archive,
    bytes: (await stat(archive)).size,
    sha256: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
    appended,
    manifestAppended,
    skill,
    skillAppended,
  }
}

if (import.meta.main) {
  try {
    await ensureDistributionArchiveInTrace()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
