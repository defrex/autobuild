/**
 * `ab init` — vendor the canonical default skills into a repo (SPEC §16.3,
 * D11). Copies, not references: per-repo customization is the point, so each
 * skill lands in the target's own `.claude/skills/ab-<name>/SKILL.md` where
 * the repo may edit it freely. Alongside the live copy, init records the
 * PRISTINE installed bytes under `.claude/skills/.ab-pristine/` — repo-
 * versioned, the base of `ab upgrade`'s three-way merges (src/cli/upgrade.ts).
 *
 * Init runs OUTSIDE build sessions: it takes a repo path, not a build, and
 * needs no AB_* environment. It is safe to re-run — an existing
 * autobuild.toml is never overwritten, and an installed skill with local
 * edits is never clobbered (`force: true` is the explicit human override).
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Installed skills are namespaced `ab-*` (§16.3): `.claude/skills/ab-plan/`. */
export const SKILL_NAMESPACE = 'ab-'

/** Where init records pristine installs, under `.claude/skills/`. */
export const PRISTINE_DIR = '.ab-pristine'

/**
 * The autobuild distribution root, resolved relative to THIS module file
 * (src/cli/init.ts → two levels up) so `ab init` works from any cwd. Its
 * `skills/` and `templates/` directories are the canonical source.
 */
export function defaultDistRoot(): string {
  return resolve(import.meta.dir, '..', '..')
}

/** Live install path: `<target>/.claude/skills/ab-<name>/SKILL.md`. */
export function installedSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, '.claude', 'skills', installName, 'SKILL.md')
}

/** Pristine record: `<target>/.claude/skills/.ab-pristine/ab-<name>/SKILL.md`. */
export function pristineSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, '.claude', 'skills', PRISTINE_DIR, installName, 'SKILL.md')
}

/** Read a file's text, or undefined when it does not exist. */
export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * The skills a model may trigger from its description (§16.3). Everything else
 * is a phase skill: invoked explicitly by the runner, never auto-triggered.
 * These two are the human/agent-facing surfaces — `spec` is the conversation
 * that writes a spec, `tickets` is how "move ticket X to ready" becomes an
 * action — so model invocation is precisely the point.
 */
export const MODEL_INVOCABLE_SKILLS = new Set(['spec', 'tickets'])

/**
 * Rewrite a canonical skill's YAML frontmatter for installation (§16.3):
 * `name` becomes the namespaced `ab-<name>`, and every skill outside
 * MODEL_INVOCABLE_SKILLS gets `disable-model-invocation: true`. The
 * description and the body below the frontmatter are preserved verbatim.
 * Deliberately minimal and line-based: two known keys do not justify a YAML
 * dependency.
 */
export function rewriteSkillSource(source: string, skillName: string): string {
  const lines = source.split('\n')
  if (lines[0] !== '---') {
    throw new Error(
      `skill "${skillName}" has no YAML frontmatter — expected the file to open with '---'`,
    )
  }
  const close = lines.indexOf('---', 1)
  if (close === -1) {
    throw new Error(
      `skill "${skillName}" has unterminated YAML frontmatter — no closing '---' found`,
    )
  }
  const front = lines
    .slice(1, close)
    .filter((line) => !line.startsWith('disable-model-invocation:'))
    .map((line) =>
      line.startsWith('name:') ? `name: ${SKILL_NAMESPACE}${skillName}` : line,
    )
  if (!MODEL_INVOCABLE_SKILLS.has(skillName)) {
    front.push('disable-model-invocation: true')
  }
  return ['---', ...front, ...lines.slice(close)].join('\n')
}

export interface DistSkill {
  /** Bare name in the distribution (`plan`). */
  name: string
  /** Namespaced install name (`ab-plan`). */
  installName: string
  /** Install content: the source with its frontmatter rewritten (§16.3). */
  content: string
}

/** Enumerate `<distRoot>/skills/<name>/SKILL.md`, sorted, install-ready. */
export async function readDistSkills(distRoot: string): Promise<DistSkill[]> {
  const skillsDir = join(distRoot, 'skills')
  const entries = await readdir(skillsDir, { withFileTypes: true })
  const skills: DistSkill[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const source = await readIfExists(join(skillsDir, entry.name, 'SKILL.md'))
    if (source === undefined) continue
    skills.push({
      name: entry.name,
      installName: `${SKILL_NAMESPACE}${entry.name}`,
      content: rewriteSkillSource(source, entry.name),
    })
  }
  return skills
}

/** Write a skill's live copy AND its pristine record (the exact same bytes). */
export async function installSkillFiles(
  targetRepo: string,
  installName: string,
  content: string,
): Promise<void> {
  const live = installedSkillPath(targetRepo, installName)
  await mkdir(dirname(live), { recursive: true })
  await writeFile(live, content)
  await writePristine(targetRepo, installName, content)
}

/** Update only the pristine record for a skill. */
export async function writePristine(
  targetRepo: string,
  installName: string,
  content: string,
): Promise<void> {
  const pristine = pristineSkillPath(targetRepo, installName)
  await mkdir(dirname(pristine), { recursive: true })
  await writeFile(pristine, content)
}

export type InitSkillAction = 'installed' | 'kept' | 'unchanged' | 'overwritten'
export type InitConfigAction = 'written' | 'skipped'

export interface InitReport {
  /** What happened to autobuild.toml. */
  config: InitConfigAction
  /** Per-skill outcome, keyed by the namespaced install name. */
  skills: Array<{ skill: string; action: InitSkillAction }>
}

export async function abInit(opts: {
  targetRepo: string
  distRoot?: string
  stdout?: (line: string) => void
  force?: boolean
}): Promise<InitReport> {
  const distRoot = opts.distRoot ?? defaultDistRoot()
  const stdout = opts.stdout ?? (() => {})
  const force = opts.force ?? false

  // autobuild.toml from the template — never overwrite an existing one
  // (§16.3): the repo's config is the repo's, from the very first re-run.
  const configPath = join(opts.targetRepo, 'autobuild.toml')
  let config: InitConfigAction
  if ((await readIfExists(configPath)) === undefined) {
    const template = await readFile(join(distRoot, 'templates', 'autobuild.toml'), 'utf8')
    await mkdir(opts.targetRepo, { recursive: true })
    await writeFile(configPath, template)
    config = 'written'
  } else {
    config = 'skipped'
  }
  stdout(`autobuild.toml: ${config}`)

  const skills: InitReport['skills'] = []
  for (const skill of await readDistSkills(distRoot)) {
    const local = await readIfExists(installedSkillPath(opts.targetRepo, skill.installName))
    let action: InitSkillAction
    if (local === undefined) {
      await installSkillFiles(opts.targetRepo, skill.installName, skill.content)
      action = 'installed'
    } else if (local === skill.content) {
      // Byte-identical to what init would write. Refreshing the pristine
      // record is safe here — local == new default means there is no local
      // divergence a future merge could need the old base for — and it
      // self-heals a missing record.
      await writePristine(opts.targetRepo, skill.installName, skill.content)
      action = 'unchanged'
    } else if (force) {
      await installSkillFiles(opts.targetRepo, skill.installName, skill.content)
      action = 'overwritten'
    } else {
      // Local edits are NEVER clobbered by init (§16.3) — upgrading an
      // edited skill is `ab upgrade`'s three-way-merge job, not init's.
      action = 'kept'
    }
    stdout(`${skill.installName}: ${action}`)
    skills.push({ skill: skill.installName, action })
  }
  return { config, skills }
}
