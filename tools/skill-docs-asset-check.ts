import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { readDistSkills } from '../packages/core/src/cli/init'
import { htmlImageTargets, markdownTargets, withoutFencedCode } from '../packages/core/src/markdown'
import { resolveTarget, type ScannedDocument } from './docs-asset-check'
import { gitTrackedPaths, repoRoot } from './git-tracked'

/**
 * Fails when a repo-local vendored skill document links to, or mentions in
 * inline code, a `docs/assets` file that git does not track.
 *
 * Scope is derived mechanically, never from a hand list: a tracked file is in
 * scope iff it is Markdown under `.agents/skills/<dir>/` and `<dir>` is
 * neither `.ab-pristine` nor a canonical install name from `readDistSkills` —
 * the same reader `tools/vendored-skills-sync.test.ts` uses. Canonical
 * vendored copies (`ab-code-review` … `ab-tickets`) are deliberately out of
 * scope: they are byte-for-byte mirrors of `skills/<name>`, enforced by
 * `vendored-skills-sync.test.ts`, and the canonical content carries its own
 * reference guard, `packages/core/src/cli/skill-self-containment.test.ts`, so
 * guarding them here would be double coverage. Repo-local skills (today
 * readme-headline, impeccable, release, vercel-builds, verify-web-dashboard,
 * ab-finalize-changelog, and ab-verify-dashboard) have no canonical copy to
 * inherit that guard from; the recorded gap this check closes was
 * `readme-headline`'s inline-code mention of `docs/assets/headline-wide.png`,
 * which no check would have noticed had the asset disappeared. Inventory
 * membership decides, not the `ab-` name prefix: some `ab-`-prefixed skills
 * have no canonical entry and stay in scope, and a newly canonicalized skill
 * leaves this guard for vendored-skills-sync's automatically. `.ab-pristine`
 * is excluded because pristine copies mirror canonical content (already
 * guarded) and are `ab upgrade`'s three-way-merge baselines.
 *
 * This is deliberately its own check rather than a widening of
 * `docs-asset-check.ts`, whose shipped-package scope is fixed by build
 * `rule-on-docs` (AUT-469): a skill document is not shipped surface, so a
 * reference from one can neither keep an asset alive nor count as broken
 * there. Correspondingly only the broken direction exists here — an asset
 * nothing mentions is docs-asset-check's orphan concern, not this check's.
 *
 * Two reference forms are extracted, both over `withoutFencedCode` (a fenced
 * block is sample text, not a live reference): link and raw-HTML `<img>`
 * targets, resolved exactly as `docs-asset-check.ts` resolves them, and
 * inline-code spans — the recorded mention class — scanned for
 * `docs/assets/<file>` path tokens. A bare token is repo-root-relative as
 * written; a `../`-prefixed token resolves against the document's directory;
 * a token inside a URL (`scheme://host/docs/assets/…`) is not a mention. A
 * reference is reported broken once per occurrence, in source order, when
 * its normalized path lands under `docs/assets/` and is not tracked.
 * References landing outside `docs/assets/` are out of scope, as are
 * non-Markdown files.
 */

const ASSET_PREFIX = 'docs/assets/'
const SKILLS_PREFIX = '.agents/skills/'
const PRISTINE_DIR = '.ab-pristine'

export interface SkillDocsAssetFinding {
  kind: 'broken'
  document: string
  target: string
  resolved: string
}

/**
 * True when `path` is a repo-local vendored skill document: Markdown under
 * `.agents/skills/<dir>/`, where `<dir>` is neither the pristine baseline
 * tree nor a canonical install name. `canonicalInstallNames` is the
 * `readDistSkills` inventory — every name it installs is guarded elsewhere,
 * so every name it does not install is this check's to guard.
 */
export function isRepoLocalSkillDoc(
  path: string,
  canonicalInstallNames: readonly string[],
): boolean {
  if (!path.toLowerCase().endsWith('.md')) {
    return false
  }
  if (!path.startsWith(SKILLS_PREFIX)) {
    return false
  }
  const rest = path.slice(SKILLS_PREFIX.length)
  const separator = rest.indexOf('/')
  if (separator === -1) {
    return false
  }
  const skill = rest.slice(0, separator)
  if (skill === PRISTINE_DIR) {
    return false
  }
  return !canonicalInstallNames.includes(skill)
}

/**
 * A path-like token inside an inline-code span naming something under
 * `docs/assets/`, optionally `../`-prefixed. The lookbehind keeps the tail of
 * a longer path — a sibling `static/docs/assets/…`, a URL's
 * `host/docs/assets/…` — from counting as a mention, and the file part must
 * end on a name character so trailing punctuation is not swallowed. Matching
 * is case-sensitive, like the `docs/assets/` prefix test every resolved path
 * goes through.
 */
const INLINE_CODE_MENTION = /(?<![\w./-])(?:\.\.\/)*docs\/assets\/[A-Za-z0-9._/-]*[A-Za-z0-9_-]/gu

function inlineCodeSpans(body: string): string[] {
  return [...body.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!)
}

/**
 * A bare mention is repo-root-relative as written — skill documents live
 * under `.agents/skills/`, so document-relative resolution would be wrong for
 * them — while a `../`-prefixed mention resolves against the document's
 * directory, like any relative link target.
 */
function resolveMention(documentPath: string, mention: string): string {
  if (mention.startsWith('../')) {
    return posix.normalize(posix.join(posix.dirname(documentPath), mention))
  }
  return posix.normalize(mention)
}

/**
 * Every occurrence in `document` that lands under `docs/assets/`, in source
 * order: link and image targets first, then inline-code mentions.
 */
export function skillDocsAssetMentions(
  document: ScannedDocument,
): { target: string; resolved: string }[] {
  const body = withoutFencedCode(document.contents)
  const occurrences: { target: string; resolved: string }[] = []

  for (const target of [...markdownTargets(body), ...htmlImageTargets(body)]) {
    const resolved = resolveTarget(document.path, target)
    if (resolved?.startsWith(ASSET_PREFIX)) {
      occurrences.push({ target, resolved })
    }
  }

  for (const span of inlineCodeSpans(body)) {
    for (const match of span.matchAll(INLINE_CODE_MENTION)) {
      const target = match[0]
      const resolved = resolveMention(document.path, target)
      if (resolved.startsWith(ASSET_PREFIX)) {
        occurrences.push({ target, resolved })
      }
    }
  }

  return occurrences
}

/**
 * `trackedAssets` is every tracked path under `docs/assets/`, image or not.
 * Unlike docs-asset-check there is no orphan direction, so no image narrowing
 * happens here and the set is the existence set as given.
 */
export function findSkillDocsAssetProblems(
  trackedAssets: Iterable<string>,
  documents: Iterable<ScannedDocument>,
): SkillDocsAssetFinding[] {
  const existing = new Set(trackedAssets)
  const findings: SkillDocsAssetFinding[] = []

  for (const document of documents) {
    for (const { target, resolved } of skillDocsAssetMentions(document)) {
      if (!existing.has(resolved)) {
        findings.push({ kind: 'broken', document: document.path, target, resolved })
      }
    }
  }

  return findings
}

export interface SkillDocsAssetCheckEnvironment {
  /** Tracked paths, repo-root-relative. Rejecting is fatal: see `runSkillDocsAssetCheck`. */
  listTrackedPaths: () => Promise<readonly string[]>
  /**
   * Canonical install names, read from the real distribution. Rejecting is
   * fatal: an inventory that silently collapsed to nothing would sweep the
   * canonical copies into this check's scope, and one that silently held
   * every skill would scan nothing at all.
   */
  listCanonicalSkillNames: () => Promise<readonly string[]>
  readTextFile: (path: string) => Promise<string>
}

/**
 * Partitions the tracked paths and hands both halves to the pure core, in the
 * same spirit as `scanDocsAssets`: only paths under `docs/assets/` join the
 * tracked-asset set, and only in-scope documents are read at all.
 */
export async function scanSkillDocsAssets(
  env: SkillDocsAssetCheckEnvironment,
): Promise<SkillDocsAssetFinding[]> {
  const canonicalNames = await env.listCanonicalSkillNames()
  const trackedAssets: string[] = []
  const documents: ScannedDocument[] = []

  for (const path of await env.listTrackedPaths()) {
    if (path.startsWith(ASSET_PREFIX)) {
      trackedAssets.push(path)
    }
    if (isRepoLocalSkillDoc(path, canonicalNames)) {
      documents.push({ path, contents: await env.readTextFile(path) })
    }
  }

  return findSkillDocsAssetProblems(trackedAssets, documents)
}

export interface SkillDocsAssetCheckOutput {
  stdout(message: string): void
  stderr(message: string): void
}

const convention =
  'A repo-local skill document may only reference or mention assets that git ' +
  'tracks under `docs/assets`. Restore the asset, repoint the skill, or drop the mention.'

function describe(finding: SkillDocsAssetFinding): string {
  return `${finding.document}: ${finding.target} (resolved ${finding.resolved}) is not a tracked file`
}

export async function runSkillDocsAssetCheck(
  env: SkillDocsAssetCheckEnvironment,
  output: SkillDocsAssetCheckOutput = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  let findings: SkillDocsAssetFinding[]
  try {
    findings = await scanSkillDocsAssets(env)
  } catch (error) {
    // A check that cannot enumerate, parse, or read must never report success.
    const message = error instanceof Error ? error.message : String(error)
    output.stderr(`Could not check skill documentation assets: ${message}\n`)
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

export const realEnvironment: SkillDocsAssetCheckEnvironment = {
  listTrackedPaths: gitTrackedPaths,
  listCanonicalSkillNames: async () =>
    (await readDistSkills(repoRoot)).map((skill) => skill.installName),
  readTextFile: (path) => readFile(join(repoRoot, path), 'utf8'),
}

if (import.meta.main) {
  process.exitCode = await runSkillDocsAssetCheck(realEnvironment)
}
