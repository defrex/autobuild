/**
 * `ab upgrade` — the classic vendoring problem (SPEC §16.3, D11). `ab init`
 * recorded the pristine bytes of every distributed skill file; upgrade
 * three-way merges pristine (base) × local (ours) × new default (theirs) so
 * local customization survives and divergence is visible instead of silent:
 *
 * The cases below apply independently to every distributed file; their
 * outcomes are folded into one deterministic per-skill report.
 *
 * - new default == pristine → nothing changed upstream; the local file
 *   stands, whatever the repo did to it (`current`).
 * - local == pristine → no local edits; adopt the new default wholesale and
 *   advance the pristine record (`adopted`).
 * - both diverged → three-way merge via `git merge-file` (git is guaranteed
 *   present; the exec seam keeps it injectable). Clean merge → write the
 *   result, advance pristine (`merged`). Conflict → the resolveConflict
 *   agent seam decides, with a standing bias: PREFER THE LOCAL CUSTOMIZATION
 *   — upstream is adopted only where it doesn't collide with what the repo
 *   deliberately changed (`resolved`). The returned full file is untrusted:
 *   deterministic validation protects the installed skill identity, rejects
 *   agent-authored marker/wrapper output, and preserves every already-clean
 *   merge region (including literal marker documentation). A
 *   missing, declined, failed, or invalid resolution escalates to a human: the
 *   LOCAL file is left byte-untouched and the report carries the merge-markered
 *   text (`conflicted`). Conflict markers are never written into the live skill.
 * - missing pristine record (pre-record install) → ambiguous: adopt only
 *   when local == new (provably no divergence), otherwise `conflicted` —
 *   never silently clobber a file whose edit history is unknowable.
 * - in the distribution but not installed → installed fresh, like init
 *   (`installed`).
 * - installed ab-* skills absent from the distribution → left alone
 *   (`unknown`); local skill additions are legitimate. The only exception is
 *   the fixed, pristine-provenance retirement of `ab-setup` and
 *   `ab-verify-e2e`: exact unreferenced or already-missing canonical trees are
 *   `removed`, while customized, configured, unsafe, or distinctly discoverable
 *   Claude trees are `kept`; every terminal classification relinquishes pristine
 *   ownership.
 *
 * Like init, upgrade runs OUTSIDE build sessions — no AB_* environment.
 */
import { randomUUID } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseConfig } from '../config/load'
import type { Exec } from '../ports/workspace/git-worktree'
import { spawnExec } from '../ports/workspace/git-worktree'
import {
  ClaudeSkillDiscoveryConflict,
  claudeSkillPath,
  defaultDistRoot,
  ensureClaudeSkillLink,
  installedSkillFilePath,
  installedSkillPath,
  listInstalledSkills,
  migrateLegacyAgentSkills,
  migrateLegacySkill,
  pristineSkillFilePath,
  readDistSkills,
  readIfExists,
  writeInstalledSkillFile,
  writePristineFile,
  type SkillDiscoveryConflict,
} from './init'

export type UpgradeSkillAction =
  | 'current'
  | 'adopted'
  | 'merged'
  | 'resolved'
  | 'conflicted'
  | 'installed'
  | 'removed'
  | 'kept'
  | 'unknown'

export interface UpgradeReport {
  /** Per-skill content outcome, keyed by the namespaced install name. */
  skills: Array<{ skill: string; action: UpgradeSkillAction; detail?: string }>
  /** Distinct Claude directories that prevented discovery-link maintenance. */
  discoveryConflicts: SkillDiscoveryConflict[]
  /** Nonzero only for discovery conflicts; content conflicts remain exit zero. */
  exitCode: number
}

/**
 * The agent seam for merge conflicts (§16.3). Receives the three exact texts
 * of the merge (base = pristine record, local = the live file, incoming =
 * the new default) and returns the resolved full text, or null to escalate
 * to a human. Standing bias for any implementation: PREFER THE LOCAL
 * CUSTOMIZATION — adopt upstream only where it doesn't collide with what
 * the repo deliberately changed.
 */
export interface ResolveConflictOptions {
  /** Per-file caller cancellation. A cancelled proposal must never be applied. */
  signal?: AbortSignal
}

export const UPGRADE_RESOLUTION_CANCELLED_MESSAGE = 'upgrade conflict resolution cancelled by human'

export class UpgradeResolutionCancelledError extends Error {
  constructor() {
    super(UPGRADE_RESOLUTION_CANCELLED_MESSAGE)
    this.name = 'UpgradeResolutionCancelledError'
  }
}

export type ResolveConflict = (
  input: {
    skill: string
    /** POSIX-style path relative to the installed skill directory. */
    path: string
    base: string
    local: string
    incoming: string
  },
  options?: ResolveConflictOptions,
) => Promise<string | null>

export interface MergeConflictLabels {
  local: string
  pristine: string
  incoming: string
}

interface MergeFileResult {
  clean: boolean
  text: string
  labels: MergeConflictLabels
}

function uniqueMergeLabels(): MergeConflictLabels {
  const nonce = randomUUID()
  return {
    local: `ab-upgrade-local-${nonce}`,
    pristine: `ab-upgrade-pristine-${nonce}`,
    incoming: `ab-upgrade-incoming-${nonce}`,
  }
}

/**
 * Three-way merge over `git merge-file -p` on temp copies. Exit code 0 is a
 * clean merge; a positive code is the number of conflicts (stdout then holds
 * the markered text); anything else is a real git error. Labels are
 * unguessable per invocation so marker-looking skill content can never be
 * mistaken for structure in this merge's output.
 */
async function mergeFile(
  exec: Exec,
  input: { base: string; local: string; incoming: string },
): Promise<MergeFileResult> {
  const dir = await mkdtemp(join(tmpdir(), 'ab-upgrade-'))
  const labels = uniqueMergeLabels()
  try {
    await writeFile(join(dir, 'local'), input.local)
    await writeFile(join(dir, 'base'), input.base)
    await writeFile(join(dir, 'incoming'), input.incoming)
    const result = await exec(
      [
        'git',
        'merge-file',
        '-p',
        '-L',
        labels.local,
        '-L',
        labels.pristine,
        '-L',
        labels.incoming,
        'local',
        'base',
        'incoming',
      ],
      { cwd: dir },
    )
    if (result.exitCode === 0) {
      return { clean: true, text: result.stdout, labels }
    }
    if (result.exitCode > 0 && result.exitCode < 127) {
      return { clean: false, text: result.stdout, labels }
    }
    throw new Error(
      `git merge-file failed (exit ${result.exitCode}): ${
        result.stderr.trim() || result.stdout.trim() || '(no output)'
      }`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const CONFLICT_MARKER_LINE = /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:[ \t].*)?\r?$/m

/** Split text into lines while retaining exact line endings. */
function linesWithEndings(text: string): string[] {
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? []
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The failed merge already contains every non-colliding local and incoming
 * edit. Extract the exact regions outside its uniquely labelled conflict
 * hunks; a resolver may replace the hunks, but it has no authority to rewrite
 * these regions.
 */
function cleanMergeRegions(marked: string, labels: MergeConflictLabels): string[] {
  const regions: string[] = []
  const startMarker = `<<<<<<< ${labels.local}`
  const endMarker = `>>>>>>> ${labels.incoming}`
  let current = ''
  let conflict = false
  let separator = false
  let sawConflict = false

  for (const line of linesWithEndings(marked)) {
    const marker = line.replace(/\r?\n$/, '')
    if (!conflict && marker === startMarker) {
      regions.push(current)
      current = ''
      conflict = true
      separator = false
      sawConflict = true
      continue
    }
    if (conflict && marker === '=======') {
      separator = true
      continue
    }
    if (conflict && marker === endMarker) {
      if (!separator) {
        throw new Error('git merge-file produced a malformed conflict without a separator')
      }
      conflict = false
      continue
    }
    if (!conflict) current += line
  }

  if (conflict) {
    throw new Error('git merge-file produced an unterminated conflict')
  }
  if (!sawConflict) {
    throw new Error('git merge-file reported a conflict without its labelled markers')
  }
  regions.push(current)
  return regions
}

interface ContentInterval {
  start: number
  end: number
}

/** Match each protected region to its exact occurrence in the proposal. */
function locateCleanRegions(
  candidate: string,
  regions: string[],
): { intervals: ContentInterval[] } | { error: string } {
  const intervals: ContentInterval[] = []
  let cursor = 0
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index] ?? ''
    if (region === '') continue

    let start: number
    if (index === 0) {
      if (!candidate.startsWith(region)) {
        return {
          error:
            'output changed or wrapped the already-clean merge region before the first conflict',
        }
      }
      start = 0
    } else if (index === regions.length - 1) {
      start = candidate.length - region.length
      if (start < cursor || !candidate.endsWith(region)) {
        return {
          error: 'output changed or wrapped the already-clean merge region after the last conflict',
        }
      }
    } else {
      start = candidate.indexOf(region, cursor)
      if (start === -1) {
        return { error: 'output omitted or changed an already-clean merge region' }
      }
    }
    intervals.push({ start, end: start + region.length })
    cursor = start + region.length
  }
  return { intervals }
}

/** Text outside protected clean intervals is the agent-authored hunk content. */
function resolutionGaps(candidate: string, intervals: ContentInterval[]): string[] {
  const gaps: string[] = []
  let cursor = 0
  for (const interval of intervals) {
    gaps.push(candidate.slice(cursor, interval.start))
    cursor = interval.end
  }
  gaps.push(candidate.slice(cursor))
  return gaps
}

function frontmatterName(candidate: string): { name?: string; error?: string } {
  const lines = candidate.split('\n')
  if (lines[0]?.replace(/\r$/, '') !== '---') {
    return { error: "output must begin at byte 0 with YAML frontmatter ('---')" }
  }
  const close = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/, '') === '---')
  if (close === -1) return { error: 'output has unterminated YAML frontmatter' }
  if (close === 1) return { error: 'output has empty YAML frontmatter' }

  const names: string[] = []
  for (const rawLine of lines.slice(1, close)) {
    const match = /^name:\s*(.*?)\s*\r?$/.exec(rawLine)
    if (match === null) continue
    let value = match[1] ?? ''
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    names.push(value)
  }
  if (names.length !== 1 || names[0] === '') {
    return { error: 'frontmatter must contain exactly one nonempty name field' }
  }
  if (
    lines
      .slice(close + 1)
      .join('\n')
      .trim() === ''
  ) {
    return { error: 'output must contain a complete nonempty skill body' }
  }
  return { name: names[0] }
}

/** Return an actionable reason when an agent proposal is unsafe. */
export function validateConflictResolution(input: {
  skill: string
  path?: string
  candidate: string
  markedMerge: string
  labels: MergeConflictLabels
}): string | undefined {
  if (input.candidate.trim() === '') return 'output was empty'

  if ((input.path ?? 'SKILL.md') === 'SKILL.md') {
    const frontmatter = frontmatterName(input.candidate)
    if (frontmatter.error !== undefined) return frontmatter.error
    if (frontmatter.name !== input.skill) {
      return `frontmatter names "${frontmatter.name}" instead of "${input.skill}"`
    }
  }

  let regions: string[]
  try {
    regions = cleanMergeRegions(input.markedMerge, input.labels)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  const located = locateCleanRegions(input.candidate, regions)
  if ('error' in located) return located.error

  // Marker-looking lines already present in an exact clean region are skill
  // content, not merge structure. Only agent-authored hunk gaps must be free
  // of standard marker lines; this rejects unresolved output without making a
  // skill that documents Git conflict syntax impossible to resolve.
  if (
    resolutionGaps(input.candidate, located.intervals).some((gap) => CONFLICT_MARKER_LINE.test(gap))
  ) {
    return 'output contains a Git conflict-marker line in a resolved hunk'
  }
  return undefined
}

function errorMessage(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim() ||
    'unknown error'
  )
}

/** The only product-owned skill retirements. Ordinary absent skills stay local. */
const RETIRED_SKILLS = ['ab-setup', 'ab-verify-e2e'] as const

type TreeEntry = { kind: 'directory' } | { kind: 'file'; content: Buffer }

interface InspectedTree {
  exists: boolean
  entries: Map<string, TreeEntry>
  unsafe?: string
}

/** Inspect every path without following links; retirements require a plain tree. */
async function inspectTree(root: string): Promise<InspectedTree> {
  let rootStat: Stats
  try {
    rootStat = await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, entries: new Map() }
    }
    throw error
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return {
      exists: true,
      entries: new Map(),
      unsafe: 'skill root is not a plain directory',
    }
  }

  const entries = new Map<string, TreeEntry>()
  const visit = async (dir: string, prefix = ''): Promise<string | undefined> => {
    const children = await readdir(dir, { withFileTypes: true })
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = prefix === '' ? child.name : `${prefix}/${child.name}`
      const absolute = join(dir, child.name)
      if (child.isDirectory()) {
        entries.set(path, { kind: 'directory' })
        const unsafe = await visit(absolute, path)
        if (unsafe !== undefined) return unsafe
      } else if (child.isFile()) {
        entries.set(path, { kind: 'file', content: await readFile(absolute) })
      } else {
        return `${path} is not a regular file or directory`
      }
    }
    return undefined
  }

  const unsafe = await visit(root)
  return { exists: true, entries, ...(unsafe === undefined ? {} : { unsafe }) }
}

function treeMismatch(live: InspectedTree, pristine: InspectedTree): string | undefined {
  if (!live.exists) return 'the installed skill tree is missing'
  if (live.unsafe !== undefined) return live.unsafe
  if (pristine.unsafe !== undefined) return `the pristine record is unsafe: ${pristine.unsafe}`
  if (pristine.entries.get('SKILL.md')?.kind !== 'file') {
    return 'the pristine record has no regular SKILL.md'
  }

  const paths = [...new Set([...live.entries.keys(), ...pristine.entries.keys()])].sort()
  for (const path of paths) {
    const local = live.entries.get(path)
    const base = pristine.entries.get(path)
    if (local === undefined) return `${path} is missing from the installed tree`
    if (base === undefined) return `${path} is a repository-local addition`
    if (local.kind !== base.kind) return `${path} changed file type`
    if (local.kind === 'file' && base.kind === 'file' && !local.content.equals(base.content)) {
      return `${path} has local edits`
    }
  }
  return undefined
}

async function configuredAgentSkills(
  targetRepo: string,
): Promise<{ skills: Set<string> } | { error: string }> {
  const path = join(targetRepo, 'autobuild.toml')
  try {
    const source = await readIfExists(path)
    if (source === undefined) return { skills: new Set() }
    const config = parseConfig(source, path)
    const skills = new Set<string>()
    for (const step of Object.values(config.verify.stepConfigs)) {
      if (step.kind === 'agent') skills.add(step.skill)
    }
    for (const step of Object.values(config.finalize.stepConfigs)) {
      if (step.kind === 'agent') skills.add(step.skill)
    }
    return { skills }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

/** Remove only the per-skill link created by init; root aliases are untouched. */
async function removeOwnedClaudeLink(targetRepo: string, installName: string): Promise<void> {
  const link = claudeSkillPath(targetRepo, installName)
  try {
    const linkStat = await lstat(link)
    if (!linkStat.isSymbolicLink()) return
    const target = resolve(dirname(link), await readlink(link))
    const canonical = resolve(dirname(installedSkillPath(targetRepo, installName)))
    if (target === canonical) await unlink(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** A real Claude directory is user-owned when the canonical tree is absent. */
async function hasDistinctClaudeDirectory(
  targetRepo: string,
  installName: string,
): Promise<boolean> {
  try {
    const discovery = await lstat(claudeSkillPath(targetRepo, installName))
    return discovery.isDirectory() && !discovery.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function abUpgrade(opts: {
  targetRepo: string
  distRoot?: string
  exec?: Exec
  resolveConflict?: ResolveConflict
  stdout?: (line: string) => void
}): Promise<UpgradeReport> {
  const distRoot = opts.distRoot ?? defaultDistRoot()
  const exec = opts.exec ?? spawnExec
  const stdout = opts.stdout ?? (() => {})
  const { targetRepo } = opts

  await migrateLegacyAgentSkills(targetRepo)

  const skills: UpgradeReport['skills'] = []
  const discoveryConflictMap = new Map<string, SkillDiscoveryConflict>()
  const containDiscoveryConflict = (error: unknown): void => {
    if (!(error instanceof ClaudeSkillDiscoveryConflict)) throw error
    discoveryConflictMap.set(error.skill, { skill: error.skill, message: error.message })
  }
  const report = (skill: string, action: UpgradeSkillAction, detail?: string): void => {
    skills.push({ skill, action, ...(detail !== undefined ? { detail } : {}) })
  }
  const precedence: UpgradeSkillAction[] = [
    'current',
    'adopted',
    'merged',
    'resolved',
    'conflicted',
  ]

  const dist = await readDistSkills(distRoot)
  for (const skill of dist) {
    const name = skill.installName
    const migrated = await migrateLegacySkill(targetRepo, name, stdout)
    try {
      await ensureClaudeSkillLink(targetRepo, name)
    } catch (error) {
      containDiscoveryConflict(error)
    }

    const incoming = new Map(skill.files.map((file) => [file.path, file.content]))
    const pristineRoot = pristineSkillFilePath(targetRepo, name, 'SKILL.md')
    const pristineFiles = new Set<string>()
    const collectPristine = async (dir: string, prefix = ''): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) await collectPristine(join(dir, entry.name), path)
        else if (entry.isFile()) pristineFiles.add(path)
      }
    }
    await collectPristine(dirname(pristineRoot))

    const paths = [...new Set([...incoming.keys(), ...pristineFiles])].sort()
    const initialLocals = new Map<string, string>()
    for (const path of paths) {
      const local =
        path === 'SKILL.md' && migrated !== undefined
          ? migrated
          : await readIfExists(installedSkillFilePath(targetRepo, name, path))
      if (local !== undefined) initialLocals.set(path, local)
    }
    const freshInstall = pristineFiles.size === 0 && initialLocals.size === 0
    const outcomes: UpgradeSkillAction[] = []
    const details: string[] = []
    const conflictHints: Array<{ path: string; reason: string }> = []

    for (const path of paths) {
      const incomingText = incoming.get(path)
      const livePath = installedSkillFilePath(targetRepo, name, path)
      const pristinePath = pristineSkillFilePath(targetRepo, name, path)
      const local = initialLocals.get(path)
      const pristine = await readIfExists(pristinePath)

      // New upstream support file (or an old install without a per-file base).
      if (pristine === undefined) {
        if (incomingText === undefined) continue
        if (local === undefined || local === incomingText) {
          await writeInstalledSkillFile(targetRepo, name, path, incomingText)
          await writePristineFile(targetRepo, name, path, incomingText)
          outcomes.push('adopted')
          if (path === 'SKILL.md' && local === incomingText) {
            details.push('SKILL.md: no pristine record; local already matches the new default')
          }
        } else {
          const reason =
            'no pristine record and local differs from the new default — refusing to ' +
            'clobber; merge by hand or re-run `ab init --force` to adopt the default'
          outcomes.push('conflicted')
          details.push(`${path}: ${reason}`)
          conflictHints.push({ path, reason })
        }
        continue
      }

      // Upstream removed a formerly distributed support file. An unedited
      // copy can be removed safely. A customized copy becomes an ordinary
      // repository-local support file and is never silently deleted.
      if (incomingText === undefined) {
        if (local === undefined || local === pristine) {
          await rm(livePath, { force: true })
          await rm(pristinePath, { force: true })
          outcomes.push('adopted')
        } else {
          await rm(pristinePath, { force: true })
          outcomes.push('merged')
          details.push(`${path}: upstream removed this file; kept the locally customized copy`)
        }
        continue
      }

      // A missing live file is restored independently. This must not make a
      // partially present skill overwrite customized siblings.
      if (local === undefined) {
        await writeInstalledSkillFile(targetRepo, name, path, incomingText)
        await writePristineFile(targetRepo, name, path, incomingText)
        outcomes.push('adopted')
        continue
      }
      if (incomingText === pristine) {
        outcomes.push('current')
        continue
      }
      if (local === pristine) {
        await writeInstalledSkillFile(targetRepo, name, path, incomingText)
        await writePristineFile(targetRepo, name, path, incomingText)
        outcomes.push('adopted')
        continue
      }
      const merge = await mergeFile(exec, {
        base: pristine,
        local,
        incoming: incomingText,
      })
      if (merge.clean) {
        await writeInstalledSkillFile(targetRepo, name, path, merge.text)
        await writePristineFile(targetRepo, name, path, incomingText)
        outcomes.push('merged')
        continue
      }

      const keepConflict = (reason: string): void => {
        outcomes.push('conflicted')
        details.push(`${path}: ${reason}\n\nmarked merge diagnostic (not written):\n${merge.text}`)
        conflictHints.push({ path, reason })
      }
      if (opts.resolveConflict === undefined) {
        keepConflict('agent resolution unavailable')
        continue
      }

      let resolved: string | null
      try {
        resolved = await opts.resolveConflict({
          skill: name,
          path,
          base: pristine,
          local,
          incoming: incomingText,
        })
      } catch (error) {
        keepConflict(`agent resolution failed: ${errorMessage(error)}`)
        continue
      }
      if (resolved === null) {
        keepConflict('agent declined because the correct resolution is ambiguous')
        continue
      }

      const invalid = validateConflictResolution({
        skill: name,
        path,
        candidate: resolved,
        markedMerge: merge.text,
        labels: merge.labels,
      })
      if (invalid !== undefined) {
        keepConflict(`agent resolution was invalid: ${invalid}`)
        continue
      }

      await writeInstalledSkillFile(targetRepo, name, path, resolved)
      await writePristineFile(targetRepo, name, path, incomingText)
      outcomes.push('resolved')
    }

    const aggregatedAction = outcomes.reduce<UpgradeSkillAction>(
      (highest, outcome) =>
        precedence.indexOf(outcome) > precedence.indexOf(highest) ? outcome : highest,
      'current',
    )
    const action: UpgradeSkillAction = freshInstall ? 'installed' : aggregatedAction
    const detail = details.length === 0 ? undefined : details.join('\n\n')
    report(name, action, detail)
    if (action === 'conflicted') {
      const conflict = conflictHints[0] ?? {
        path: 'SKILL.md',
        reason: 'manual merge required',
      }
      stdout(
        `${name}: conflicted — ${conflict.reason}; kept your local file ` +
          `(merge by hand against .agents/skills/.ab-pristine/${name}/${conflict.path})`,
      )
    } else {
      stdout(`${name}: ${action}`)
    }
  }

  const distNames = new Set(dist.map((skill) => skill.installName))
  const configured = await configuredAgentSkills(targetRepo)
  for (const name of RETIRED_SKILLS) {
    // A distribution that still ships the name owns it through the ordinary
    // merge path. Retirement begins only once the incoming distribution drops it.
    if (distNames.has(name)) continue

    const liveRoot = dirname(installedSkillPath(targetRepo, name))
    const pristineRoot = dirname(pristineSkillFilePath(targetRepo, name, 'SKILL.md'))
    let pristine: InspectedTree
    let live: InspectedTree
    try {
      ;[pristine, live] = await Promise.all([inspectTree(pristineRoot), inspectTree(liveRoot)])
    } catch (error) {
      // If provenance itself cannot be inspected, leave all bytes and surface
      // the infrastructure error rather than guessing that deletion is safe.
      report(name, 'kept', `could not inspect retirement candidate safely: ${errorMessage(error)}`)
      stdout(`${name}: kept (could not inspect retirement candidate safely)`)
      continue
    }
    // No pristine provenance means this is repository-authored (or a prior
    // retirement already cleared ownership). Do not migrate a surviving
    // user-owned Claude directory back into the canonical tree on a later run.
    if (!pristine.exists) continue

    // Preserve legacy migration for complete canonical installations, but a
    // missing canonical tree must be classified before discovery maintenance
    // can create a dangling link or move a distinct Claude directory.
    if (live.exists) {
      await migrateLegacySkill(targetRepo, name, stdout)
      try {
        ;[pristine, live] = await Promise.all([inspectTree(pristineRoot), inspectTree(liveRoot)])
      } catch (error) {
        report(
          name,
          'kept',
          `could not inspect retirement candidate safely: ${errorMessage(error)}`,
        )
        stdout(`${name}: kept (could not inspect retirement candidate safely)`)
        continue
      }
    }

    if (!live.exists) {
      const distinctClaudeDirectory = await hasDistinctClaudeDirectory(targetRepo, name)
      if (distinctClaudeDirectory) {
        containDiscoveryConflict(new ClaudeSkillDiscoveryConflict(targetRepo, name))
      }
      await removeOwnedClaudeLink(targetRepo, name)
      await rm(pristineRoot, { recursive: true, force: true })

      const action: UpgradeSkillAction = distinctClaudeDirectory ? 'kept' : 'removed'
      const detail = distinctClaudeDirectory
        ? 'retired canonical tree was already missing; distinct user-owned Claude discovery directory remains'
        : 'retired distribution skill; installed tree was already missing'
      report(name, action, detail)
      stdout(`${name}: ${action} (${detail})`)
      continue
    }

    let distinctClaudeDirectory = false
    try {
      await ensureClaudeSkillLink(targetRepo, name)
    } catch (error) {
      if (error instanceof ClaudeSkillDiscoveryConflict) distinctClaudeDirectory = true
      containDiscoveryConflict(error)
    }

    const mismatch = treeMismatch(live, pristine)
    const reason =
      'error' in configured
        ? `could not safely inspect autobuild.toml references: ${configured.error}`
        : configured.skills.has(name)
          ? `still referenced by autobuild.toml as an agent step skill`
          : mismatch === undefined
            ? undefined
            : `locally customized: ${mismatch}`

    if (reason !== undefined) {
      // Relinquish obsolete ownership. The live tree is now an ordinary local
      // skill, so later upgrades neither repeat this report nor remove it.
      await rm(pristineRoot, { recursive: true, force: true })
      report(name, 'kept', reason)
      stdout(`${name}: kept (${reason})`)
      continue
    }

    await removeOwnedClaudeLink(targetRepo, name)
    await rm(liveRoot, { recursive: true, force: true })
    await rm(pristineRoot, { recursive: true, force: true })
    if (distinctClaudeDirectory) {
      const detail =
        'retired canonical tree matched pristine and was removed; distinct user-owned Claude discovery directory remains'
      report(name, 'kept', detail)
      stdout(`${name}: kept (${detail})`)
    } else {
      report(name, 'removed', 'retired distribution skill; installed tree matched pristine')
      stdout(`${name}: removed (retired distribution skill; installed tree matched pristine)`)
    }
  }

  const retiredNames = new Set<string>(RETIRED_SKILLS)
  for (const name of await listInstalledSkills(targetRepo)) {
    if (distNames.has(name) || retiredNames.has(name)) continue
    try {
      await ensureClaudeSkillLink(targetRepo, name)
    } catch (error) {
      containDiscoveryConflict(error)
    }
    report(name, 'unknown', 'not in the distribution — left alone (local addition)')
    stdout(`${name}: unknown (not in the distribution — left alone)`)
  }

  const discoveryConflicts = [...discoveryConflictMap.values()]
  if (discoveryConflicts.length > 0) {
    stdout('Claude discovery conflicts:')
    for (const conflict of discoveryConflicts) stdout(`  ${conflict.message}`)
  }

  return {
    skills,
    discoveryConflicts,
    exitCode: discoveryConflicts.length > 0 ? 1 : 0,
  }
}
