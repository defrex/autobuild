import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { htmlImageTargets, markdownTargets, withoutFencedCode } from '../src/markdown'
import { gitTrackedPaths, repoRoot } from './git-tracked'

/**
 * Fails when a tracked image under `docs/assets` is rendered by no document
 * this repository ships, or when a shipped document points into `docs/assets`
 * at a file that is not tracked.
 *
 * The orphan this was written for was produced by a routine README edit
 * (70d7670 deleted the section, not the image), survived two commits unnoticed,
 * and cost a hand-retouch before an agent's observation caught it. It is
 * repository-local tooling, not product surface, exactly as
 * `product-name-check.ts` is.
 */

const ASSET_PREFIX = 'docs/assets/'

/**
 * Acceptance criterion 1's "every image" governs the *orphan* invariant only.
 * A non-image file under ASSET_PREFIX is not required to be rendered — but it
 * is still a tracked file, so a reference to it is not broken. Compared
 * case-insensitively.
 */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif'] as const

export interface ScannedDocument {
  path: string
  contents: string
}

export type DocsAssetFinding =
  | { kind: 'orphan'; asset: string }
  | { kind: 'broken'; document: string; target: string; resolved: string }

/**
 * True when `path` is Markdown inside the published package — an entry of
 * `package.json`'s `files`, or below one. The prefix test uses `entry + '/'`,
 * so a `docs` entry does not capture a sibling `docsfoo/`.
 *
 * Canonical `skills/**` is inside `files` and therefore counted, even though a
 * canonical skill cannot in fact reference `docs/assets` without failing
 * `src/cli/skill-self-containment.test.ts`. Counting it is vacuous rather than
 * wrong, and deriving the set mechanically from `files` cannot fall out of date
 * the way a hand-maintained list would.
 */
export function isShippedDocument(path: string, packageFiles: readonly string[]): boolean {
  if (!path.toLowerCase().endsWith('.md')) {
    return false
  }
  return packageFiles.some((rawEntry) => {
    const entry = rawEntry.replace(/\/+$/u, '')
    return entry.length > 0 && (path === entry || path.startsWith(`${entry}/`))
  })
}

/** Extension is in IMAGE_EXTENSIONS, matched case-insensitively. */
export function isImageAsset(path: string): boolean {
  const extension = posix.extname(path).toLowerCase()
  return IMAGE_EXTENSIONS.some((candidate) => candidate === extension)
}

/**
 * A reference's target as written and where it lands, repo-root-relative.
 * `undefined` for anything that cannot name a tracked file: a scheme, a
 * bare fragment, or an empty remainder.
 */
function resolveTarget(documentPath: string, rawTarget: string): string | undefined {
  // Any scheme at all — `https:`, `mailto:`, `data:`. None can name a path in
  // this repository, and `[a-z0-9+.-]*` cannot cross a `/`, so a relative path
  // containing a colon is still resolved.
  if (/^[a-z][a-z0-9+.-]*:/iu.test(rawTarget) || rawTarget.startsWith('#')) {
    return undefined
  }
  const withoutFragment = rawTarget.split('#', 1)[0]!.trim()
  if (withoutFragment === '') {
    return undefined
  }
  if (withoutFragment.startsWith('/')) {
    return posix.normalize(withoutFragment.slice(1))
  }
  return posix.normalize(posix.join(posix.dirname(documentPath), withoutFragment))
}

/**
 * Every reference in `document` that lands under ASSET_PREFIX. A fenced code
 * block is sample text, not a rendered reference, so it is blanked first.
 * Markdown targets precede raw-HTML ones; the order within each is the
 * source's, which is all a stable report needs.
 */
function assetReferences(document: ScannedDocument): { target: string; resolved: string }[] {
  const body = withoutFencedCode(document.contents)
  const references: { target: string; resolved: string }[] = []
  for (const target of [...markdownTargets(body), ...htmlImageTargets(body)]) {
    const resolved = resolveTarget(document.path, target)
    if (resolved?.startsWith(ASSET_PREFIX)) {
      references.push({ target, resolved })
    }
  }
  return references
}

/**
 * `trackedAssets` is *every* tracked path under ASSET_PREFIX, image or not, and
 * the core derives the image subset itself. The two sets serve opposite
 * directions and must not be collapsed:
 *
 * - existence set — all of `trackedAssets`. A reference landing under the
 *   prefix is `broken` only when its target is in none of them.
 * - orphan set — the images among them. Only these can earn an `orphan`.
 *
 * Narrowing at the boundary instead would make a tracked
 * `docs/assets/notes.txt` indistinguishable from an untracked one, so a live
 * link to it would be reported `broken`.
 */
export function findDocsAssetProblems(
  trackedAssets: Iterable<string>,
  documents: Iterable<ScannedDocument>,
): DocsAssetFinding[] {
  const assets = [...trackedAssets]
  const existing = new Set(assets)
  const referenced = new Set<string>()
  const broken: DocsAssetFinding[] = []

  for (const document of documents) {
    for (const { target, resolved } of assetReferences(document)) {
      if (existing.has(resolved)) {
        referenced.add(resolved)
      } else {
        broken.push({ kind: 'broken', document: document.path, target, resolved })
      }
    }
  }

  const orphans = assets
    .filter((asset) => isImageAsset(asset) && !referenced.has(asset))
    .map((asset): DocsAssetFinding => ({ kind: 'orphan', asset }))

  return [...orphans, ...broken]
}

export interface DocsAssetCheckEnvironment {
  /** Tracked paths, repo-root-relative. Rejecting is fatal: see `runDocsAssetCheck`. */
  listTrackedPaths: () => Promise<readonly string[]>
  readTextFile: (path: string) => Promise<string>
}

/**
 * The shipped-document boundary, read from the real published package rather
 * than hardcoded. Failing closed matters more here than anywhere else in the
 * check: a `files` that silently collapsed to "nothing counts" would report
 * every asset as an orphan and teach the next reader to distrust the check.
 */
function parsePackageFiles(contents: string): readonly string[] {
  const parsed: unknown = JSON.parse(contents)
  const files =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { files?: unknown }).files
      : undefined
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every((entry) => typeof entry === 'string' && entry.length > 0)
  ) {
    throw new Error(
      'package.json has no usable `files` array, so the set of documents the repository ships cannot be established',
    )
  }
  return files
}

/**
 * Partitions the tracked paths and hands both halves to the pure core. *Any*
 * path under ASSET_PREFIX joins the tracked-asset set — the image narrowing
 * belongs to the core, not here.
 *
 * Reading is plain, unlike `product-name-check.ts`, which classifies with
 * `lstat` because it attributes a violation to the path it reads. Nothing in
 * the shipped Markdown set is a symlink — `CLAUDE.md`, this repository's only
 * `.md` symlink, is not in `files` — and a symlinked document would be read as
 * its target's text, which is the right content to scan for references anyway.
 */
export async function scanDocsAssets(env: DocsAssetCheckEnvironment): Promise<DocsAssetFinding[]> {
  const packageFiles = parsePackageFiles(await env.readTextFile('package.json'))
  const paths = await env.listTrackedPaths()
  const trackedAssets: string[] = []
  const documents: ScannedDocument[] = []

  for (const path of paths) {
    if (path.startsWith(ASSET_PREFIX)) {
      trackedAssets.push(path)
    }
    if (isShippedDocument(path, packageFiles)) {
      documents.push({ path, contents: await env.readTextFile(path) })
    }
  }

  return findDocsAssetProblems(trackedAssets, documents)
}

export interface DocsAssetCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

const convention =
  'Every image tracked under `docs/assets` must be rendered by a document the ' +
  "repository ships (`package.json`'s `files`). Wire it into a page that needs " +
  'it, or stop tracking it.'

function describe(finding: DocsAssetFinding): string {
  return finding.kind === 'orphan'
    ? `${finding.asset}: tracked, but no document the repository ships renders it`
    : `${finding.document}: ${finding.target} (resolved ${finding.resolved}) is not a tracked file`
}

export async function runDocsAssetCheck(
  env: DocsAssetCheckEnvironment,
  output: DocsAssetCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let findings: DocsAssetFinding[]
  try {
    findings = await scanDocsAssets(env)
  } catch (error) {
    // A check that cannot enumerate, parse, or read must never report success.
    const message = error instanceof Error ? error.message : String(error)
    output.stderr(`Could not check documentation assets: ${message}\n`)
    return 1
  }

  if (findings.length === 0) {
    return 0
  }

  for (const finding of findings) {
    output.stdout(`${describe(finding)}\n`)
  }
  output.stderr(`${convention}\n`)
  return 1
}

export const realEnvironment: DocsAssetCheckEnvironment = {
  listTrackedPaths: gitTrackedPaths,
  readTextFile: (path) => readFile(join(repoRoot, path), 'utf8'),
}

if (import.meta.main) {
  process.exitCode = await runDocsAssetCheck(realEnvironment)
}
