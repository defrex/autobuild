/**
 * `ab upgrade` — the classic vendoring problem (SPEC §16.3, D11). `ab init`
 * recorded the pristine bytes of every installed skill; upgrade three-way
 * merges pristine (base) × local (ours) × new default (theirs) so local
 * customization survives and divergence is visible instead of silent:
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
 *   deliberately changed (`resolved`). A null result (or no resolver)
 *   escalates to a human: the LOCAL file is left byte-untouched and the
 *   report carries the merge-markered text (`conflicted`). Conflict markers
 *   are never written into the live skill.
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
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { spawnExec } from '../ports/workspace/git-worktree'
import {
  SKILL_NAMESPACE,
  defaultDistRoot,
  installSkillFiles,
  installedSkillPath,
  pristineSkillPath,
  readDistSkills,
  readIfExists,
  writePristine,
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
  base: string
  local: string
  incoming: string
}) => Promise<string | null>

/**
 * Three-way merge over `git merge-file -p` on temp copies. Exit code 0 is a
 * clean merge; a positive code is the number of conflicts (stdout then holds
 * the markered text); anything else is a real git error.
 */
async function mergeFile(
  exec: Exec,
  input: { base: string; local: string; incoming: string },
): Promise<{ clean: boolean; text: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ab-upgrade-'))
  try {
    await writeFile(join(dir, 'local'), input.local)
    await writeFile(join(dir, 'base'), input.base)
    await writeFile(join(dir, 'incoming'), input.incoming)
    const result = await exec(
      [
        'git', 'merge-file', '-p',
        '-L', 'local', '-L', 'pristine', '-L', 'upstream',
        'local', 'base', 'incoming',
      ],
      { cwd: dir },
    )
    if (result.exitCode === 0) return { clean: true, text: result.stdout }
    if (result.exitCode > 0 && result.exitCode < 127) {
      return { clean: false, text: result.stdout }
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

/** Installed `ab-*` skill dirs under `<target>/.claude/skills/`, sorted. */
async function listInstalledSkills(targetRepo: string): Promise<string[]> {
  const dir = join(targetRepo, '.claude', 'skills')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SKILL_NAMESPACE)) continue
    if ((await readIfExists(join(dir, entry.name, 'SKILL.md'))) === undefined) continue
    names.push(entry.name)
  }
  return names.sort()
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

  const skills: UpgradeReport['skills'] = []
  const report = (skill: string, action: UpgradeSkillAction, detail?: string): void => {
    skills.push({ skill, action, ...(detail !== undefined ? { detail } : {}) })
  }

  const dist = await readDistSkills(distRoot)
  for (const skill of dist) {
    const name = skill.installName
    const incoming = skill.content
    const local = await readIfExists(installedSkillPath(targetRepo, name))

    if (local === undefined) {
      // In the distribution but not installed — install fresh, like init.
      await installSkillFiles(targetRepo, name, incoming)
      report(name, 'installed')
      stdout(`${name}: installed`)
      continue
    }

    const pristine = await readIfExists(pristineSkillPath(targetRepo, name))

    if (pristine === undefined) {
      // Pre-record install: without a base, edits are indistinguishable
      // from an older default. Adopt only the provably-safe direction.
      if (local === incoming) {
        await writePristine(targetRepo, name, incoming)
        report(name, 'adopted', 'no pristine record; local already matches the new default')
        stdout(`${name}: adopted (no pristine record; local already matched)`)
      } else {
        const detail =
          'no pristine record and local differs from the new default — refusing to ' +
          'clobber; merge by hand or re-run `ab init --force` to adopt the default'
        report(name, 'conflicted', detail)
        stdout(`${name}: conflicted — ${detail}`)
      }
      continue
    }

    if (incoming === pristine) {
      // Nothing changed upstream; local stands, edited or not.
      report(name, 'current')
      stdout(`${name}: current`)
      continue
    }

    if (local === pristine) {
      // No local edits; adopt the new default wholesale.
      await installSkillFiles(targetRepo, name, incoming)
      report(name, 'adopted')
      stdout(`${name}: adopted`)
      continue
    }

    // Both diverged: three-way merge base=pristine, ours=local, theirs=new.
    const merge = await mergeFile(exec, { base: pristine, local, incoming })
    if (merge.clean) {
      await writeFile(installedSkillPath(targetRepo, name), merge.text)
      await writePristine(targetRepo, name, incoming)
      report(name, 'merged')
      stdout(`${name}: merged`)
      continue
    }

    const resolved =
      opts.resolveConflict !== undefined
        ? await opts.resolveConflict({ skill: name, base: pristine, local, incoming })
        : null
    if (resolved !== null) {
      await writeFile(installedSkillPath(targetRepo, name), resolved)
      await writePristine(targetRepo, name, incoming)
      report(name, 'resolved')
      stdout(`${name}: resolved`)
    } else {
      // The escalation path: a human decides. The live file stays
      // byte-untouched (never write conflict markers into it); the report
      // carries the markered merge text.
      report(name, 'conflicted', merge.text)
      stdout(
        `${name}: conflicted — local edits collide with the new default; ` +
          `kept your local file (merge by hand against .claude/skills/.ab-pristine/${name}/SKILL.md)`,
      )
    }
  }

  // Installed ab-* skills absent from the distribution: local additions are
  // legitimate — left alone, surfaced as unknown.
  const distNames = new Set(dist.map((skill) => skill.installName))
  for (const name of await listInstalledSkills(targetRepo)) {
    if (distNames.has(name)) continue
    report(name, 'unknown', 'not in the distribution — left alone (local addition)')
    stdout(`${name}: unknown (not in the distribution — left alone)`)
  }

  return { skills }
}
