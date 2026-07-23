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
 *   (`unknown`); local skill additions are legitimate.
 *
 * Like init, upgrade runs OUTSIDE build sessions — no AB_* environment.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { spawnExec } from '../ports/workspace/git-worktree'
import {
  defaultDistRoot,
  ensureClaudeSkillLink,
  installedSkillFilePath,
  listInstalledSkills,
  migrateLegacyAgentSkills,
  migrateLegacySkill,
  pristineSkillFilePath,
  readDistSkills,
  readIfExists,
  writeInstalledSkillFile,
  writePristineFile,
} from './init'

export type UpgradeSkillAction =
  | 'current'
  | 'adopted'
  | 'merged'
  | 'resolved'
  | 'conflicted'
  | 'installed'
  | 'unknown'

export interface UpgradeReport {
  /** Per-skill outcome, keyed by the namespaced install name. */
  skills: Array<{ skill: string; action: UpgradeSkillAction; detail?: string }>
}

/**
 * The agent seam for merge conflicts (§16.3). Receives the three exact texts
 * of the merge (base = pristine record, local = the live file, incoming =
 * the new default) and returns the resolved full text, or null to escalate
 * to a human. Standing bias for any implementation: PREFER THE LOCAL
 * CUSTOMIZATION — adopt upstream only where it doesn't collide with what
 * the repo deliberately changed.
 */
export type ResolveConflict = (input: {
  skill: string
  /** POSIX-style path relative to the installed skill directory. */
  path: string
  base: string
  local: string
  incoming: string
}) => Promise<string | null>

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
function cleanMergeRegions(
  marked: string,
  labels: MergeConflictLabels,
): string[] {
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
          error:
            'output changed or wrapped the already-clean merge region after the last conflict',
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
function resolutionGaps(
  candidate: string,
  intervals: ContentInterval[],
): string[] {
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
  const close = lines.findIndex(
    (line, index) => index > 0 && line.replace(/\r$/, '') === '---',
  )
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
  if (lines.slice(close + 1).join('\n').trim() === '') {
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
    resolutionGaps(input.candidate, located.intervals).some((gap) =>
      CONFLICT_MARKER_LINE.test(gap),
    )
  ) {
    return 'output contains a Git conflict-marker line in a resolved hunk'
  }
  return undefined
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim() || 'unknown error'
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
    await ensureClaudeSkillLink(targetRepo, name)

    const incoming = new Map(skill.files.map((file) => [file.path, file.content]))
    const pristineRoot = pristineSkillFilePath(targetRepo, name, 'SKILL.md')
    const pristineFiles = new Set<string>()
    const collectPristine = async (dir: string, prefix = ''): Promise<void> => {
      let entries
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
            details.push(
              'SKILL.md: no pristine record; local already matches the new default',
            )
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
          details.push(
            `${path}: upstream removed this file; kept the locally customized copy`,
          )
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
        details.push(
          `${path}: ${reason}\n\nmarked merge diagnostic (not written):\n${merge.text}`,
        )
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
  for (const name of await listInstalledSkills(targetRepo)) {
    if (distNames.has(name)) continue
    await ensureClaudeSkillLink(targetRepo, name)
    report(name, 'unknown', 'not in the distribution — left alone (local addition)')
    stdout(`${name}: unknown (not in the distribution — left alone)`)
  }

  return { skills }
}
