/**
 * `ab init` — vendor the canonical default skills into a repo (SPEC §16.3,
 * D11). Copies, not references: per-repo customization is the point, so each
 * complete skill tree lands in the Agent Skills standard
 * `.agents/skills/ab-<name>/`, where the repo may edit every file freely. Pi
 * discovers that project directory
 * directly; Claude discovers the same skill through a
 * `.claude/skills/ab-<name>` symlink, so there is only one editable copy.
 * Alongside the live copy, init records the PRISTINE installed bytes under
 * `.agents/skills/.ab-pristine/` — repo-versioned, the base of `ab upgrade`'s
 * three-way merges (src/cli/upgrade.ts).
 *
 * Init runs OUTSIDE build sessions: it takes a repo path, not a build, and
 * needs no AB_* environment. It is safe to re-run — an existing
 * autobuild.toml is never overwritten, and an installed skill with local
 * edits is never clobbered (`force: true` is the explicit human override).
 */
import type { Dirent, Stats } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { installedSkillName, SKILL_NAMESPACE } from '../skills'
import { createProductionRuntimes } from '../ports/runner/production'
import type { RuntimeRegistry } from '../ports/runner/runtime'
import {
  launchSetupAgent,
  probeInitRuntimes,
  selectSetupRuntime,
  SETUP_RUNTIME_PREFERENCE,
  type SetupAgentLauncher,
} from './init-agent'

export { SKILL_NAMESPACE }

/** Agent Skills standard project directory for vendored skills. */
export const AGENTS_SKILLS_DIR = join('.agents', 'skills')

/** The unsupported project path used by earlier autobuild releases. */
export const LEGACY_AGENT_SKILLS_DIR = join('.agent', 'skills')

/** Claude-compatible discovery links point at the canonical skills. */
export const CLAUDE_SKILLS_DIR = join('.claude', 'skills')

/** Where init records pristine installs, under `.agents/skills/`. */
export const PRISTINE_DIR = '.ab-pristine'

/** Repository-local state is always excluded by a fresh/repeated init. */
export const LOCAL_STATE_IGNORE_RULE = '.autobuild/'

/**
 * The autobuild distribution root, resolved relative to THIS module file
 * (src/cli/init.ts → two levels up) so `ab init` works from any cwd. Its
 * `skills/` and `templates/` directories are the canonical source.
 */
export function defaultDistRoot(): string {
  return resolve(import.meta.dir, '..', '..')
}

function assertSkillRelativePath(file: string): void {
  if (
    file === '' ||
    file.startsWith('/') ||
    file.startsWith('\\') ||
    file.split(/[\\/]/).some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid skill-relative file path "${file}"`)
  }
}

/** Live path for one file in an installed skill directory. */
export function installedSkillFilePath(
  targetRepo: string,
  installName: string,
  file: string,
): string {
  assertSkillRelativePath(file)
  return join(targetRepo, AGENTS_SKILLS_DIR, installName, ...file.split('/'))
}

/** Live install path: `<target>/.agents/skills/ab-<name>/SKILL.md`. */
export function installedSkillPath(targetRepo: string, installName: string): string {
  return installedSkillFilePath(targetRepo, installName, 'SKILL.md')
}

/** Claude discovery path: a directory symlink to the live `.agents` skill. */
export function claudeSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, CLAUDE_SKILLS_DIR, installName)
}

/** Pristine path for one distributed file in a skill directory. */
export function pristineSkillFilePath(
  targetRepo: string,
  installName: string,
  file: string,
): string {
  assertSkillRelativePath(file)
  return join(targetRepo, AGENTS_SKILLS_DIR, PRISTINE_DIR, installName, ...file.split('/'))
}

/** Pristine record: `<target>/.agents/skills/.ab-pristine/ab-<name>/SKILL.md`. */
export function pristineSkillPath(targetRepo: string, installName: string): string {
  return pristineSkillFilePath(targetRepo, installName, 'SKILL.md')
}

function legacyInstalledSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, CLAUDE_SKILLS_DIR, installName, 'SKILL.md')
}

function legacyPristineSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, CLAUDE_SKILLS_DIR, PRISTINE_DIR, installName, 'SKILL.md')
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
 * Ensure the exact repository-local state rule exists without rewriting any
 * existing ignore bytes. Re-running is duplicate-free, including when the
 * original file had no trailing newline.
 */
export async function ensureLocalStateIgnored(targetRepo: string): Promise<boolean> {
  const path = join(targetRepo, '.gitignore')
  const current = await readIfExists(path)
  if (current !== undefined) {
    const rules = current.split(/\r?\n/)
    if (rules.includes(LOCAL_STATE_IGNORE_RULE)) return false
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    await writeFile(path, `${current}${separator}${LOCAL_STATE_IGNORE_RULE}\n`)
    return true
  }
  await mkdir(targetRepo, { recursive: true })
  await writeFile(path, `${LOCAL_STATE_IGNORE_RULE}\n`)
  return true
}

/**
 * The skills a model may trigger from its description (§16.3). Everything else
 * gets `disable-model-invocation: true`: phase skills are invoked explicitly by
 * the runner or a human, and a model must never start a pipeline phase by
 * pattern-matching a description. Membership here is reserved for skills that
 * drive NO phase — `spec` is the conversation that writes a spec before a build
 * exists, `tickets` is how "move ticket X to ready" becomes an action, and
 * `guide` is read-only reference material about the system. For these, model
 * invocation is precisely the point. Keep this set small; widening it needs the
 * §16.3 criterion, not convenience.
 */
export const MODEL_INVOCABLE_SKILLS = new Set(['spec', 'tickets', 'guide'])

/**
 * Rewrite a canonical skill's YAML frontmatter for installation (§16.3):
 * `name` becomes the namespaced `ab-<name>`, and every skill outside
 * `MODEL_INVOCABLE_SKILLS` gets `disable-model-invocation: true`. The
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
    .map((line) => (line.startsWith('name:') ? `name: ${installedSkillName(skillName)}` : line))
  if (!MODEL_INVOCABLE_SKILLS.has(skillName)) {
    front.push('disable-model-invocation: true')
  }
  return ['---', ...front, ...lines.slice(close)].join('\n')
}

export interface DistSkillFile {
  /** POSIX-style path relative to `skills/<name>/`. */
  path: string
  /** Install-ready text. Only SKILL.md receives frontmatter rewriting. */
  content: string
}

export interface DistSkill {
  /** Bare name in the distribution (`plan`). */
  name: string
  /** Namespaced install name (`ab-plan`). */
  installName: string
  /** SKILL.md install content, retained as a convenience for existing callers. */
  content: string
  /** Every regular file in the canonical skill tree, path-sorted. */
  files: DistSkillFile[]
}

async function readSkillTree(root: string, prefix = ''): Promise<DistSkillFile[]> {
  const entries = await readdir(join(root, ...prefix.split('/').filter(Boolean)), {
    withFileTypes: true,
  })
  const files: DistSkillFile[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await readSkillTree(root, path)))
    } else if (entry.isFile()) {
      assertSkillRelativePath(path)
      files.push({
        path,
        content: await readFile(join(root, ...path.split('/')), 'utf8'),
      })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** Enumerate complete `<distRoot>/skills/<name>/` trees, sorted, install-ready. */
export async function readDistSkills(distRoot: string): Promise<DistSkill[]> {
  const skillsDir = join(distRoot, 'skills')
  const entries = await readdir(skillsDir, { withFileTypes: true })
  const skills: DistSkill[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const root = join(skillsDir, entry.name)
    const files = await readSkillTree(root)
    const skillFile = files.find((file) => file.path === 'SKILL.md')
    if (skillFile === undefined) continue
    skillFile.content = rewriteSkillSource(skillFile.content, entry.name)
    skills.push({
      name: entry.name,
      installName: installedSkillName(entry.name),
      content: skillFile.content,
      files,
    })
  }
  return skills
}

/** True when two existing directory paths resolve to the same filesystem entry. */
async function sameDirectoryEntry(left: string, right: string): Promise<boolean> {
  let leftStat: Stats
  let rightStat: Stats
  try {
    ;[leftStat, rightStat] = await Promise.all([stat(left), stat(right)])
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return (
    leftStat.isDirectory() &&
    rightStat.isDirectory() &&
    leftStat.dev === rightStat.dev &&
    leftStat.ino === rightStat.ino
  )
}

async function symlinkPointsAt(link: string, target: string): Promise<boolean> {
  try {
    const linkStat = await lstat(link)
    if (!linkStat.isSymbolicLink()) return false
    return resolve(dirname(link), await readlink(link)) === resolve(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Recognize a root alias even while its target is still missing, and
 * materialize that target so later writes through either spelling succeed.
 */
async function prepareAliasedSkillRoots(targetRepo: string): Promise<boolean> {
  const agentsRoot = join(targetRepo, AGENTS_SKILLS_DIR)
  const claudeRoot = join(targetRepo, CLAUDE_SKILLS_DIR)
  if (await sameDirectoryEntry(agentsRoot, claudeRoot)) return true
  if (await symlinkPointsAt(claudeRoot, agentsRoot)) {
    await mkdir(agentsRoot, { recursive: true })
    return true
  }
  if (await symlinkPointsAt(agentsRoot, claudeRoot)) {
    await mkdir(claudeRoot, { recursive: true })
    return true
  }
  return false
}

/** An actionable collision with a distinct, user-owned Claude skill directory. */
export class ClaudeSkillDiscoveryConflict extends Error {
  readonly skill: string

  constructor(targetRepo: string, installName: string) {
    const claude = relative(targetRepo, claudeSkillPath(targetRepo, installName))
    const canonical = relative(targetRepo, dirname(installedSkillPath(targetRepo, installName)))
    super(
      `cannot create Claude discovery link for "${installName}": ${claude} is a distinct ` +
        `real directory from ${canonical}; move or remove ${claude}, then rerun the command`,
    )
    this.name = 'ClaudeSkillDiscoveryConflict'
    this.skill = installName
  }
}

/** Ensure Claude discovers the canonical `.agents` skill through a symlink. */
export async function ensureClaudeSkillLink(
  targetRepo: string,
  installName: string,
): Promise<void> {
  const link = claudeSkillPath(targetRepo, installName)
  const target = dirname(installedSkillPath(targetRepo, installName))
  // A repository-level alias already gives Claude the canonical tree. Check
  // before touching a per-skill path: on a fresh upgrade its target root may
  // not yet exist, and creating through the alias would create a self-link.
  if (await prepareAliasedSkillRoots(targetRepo)) return

  await mkdir(dirname(link), { recursive: true })

  try {
    const linkStat = await lstat(link)
    if (linkStat.isSymbolicLink()) {
      const current = resolve(dirname(link), await readlink(link))
      if (current === resolve(target) || (await sameDirectoryEntry(link, target))) return
      await unlink(link)
    } else if (linkStat.isDirectory()) {
      if (await sameDirectoryEntry(link, target)) return
      throw new ClaudeSkillDiscoveryConflict(targetRepo, installName)
    } else {
      throw new Error(
        `cannot create Claude link for "${installName}": ` +
          `${CLAUDE_SKILLS_DIR}/${installName} exists and is not a directory symlink`,
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  await symlink(relative(dirname(link), target), link, 'dir')
}

/**
 * Recursively move non-conflicting entries from an obsolete directory into
 * its replacement. Existing destination entries always win, so migration
 * cannot clobber data; conflicting source entries remain for manual recovery.
 */
async function moveMissingEntries(source: string, destination: string): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  await mkdir(destination, { recursive: true })
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    let destinationStat: Stats
    try {
      destinationStat = await lstat(to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await rename(from, to)
      continue
    }

    const sourceStat = await lstat(from)
    if (
      sourceStat.isDirectory() &&
      !sourceStat.isSymbolicLink() &&
      destinationStat.isDirectory() &&
      !destinationStat.isSymbolicLink()
    ) {
      await moveMissingEntries(from, to)
    }
  }

  try {
    await rmdir(source)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
  }
}

/**
 * Migrate the unsupported `.agent/skills` project layout used by older
 * releases into the Agent Skills standard `.agents/skills` directory. The
 * whole tree is considered so local `ab-*` additions, supporting files, and
 * pristine merge bases move together. Safe and idempotent.
 */
export async function migrateLegacyAgentSkills(targetRepo: string): Promise<void> {
  await prepareAliasedSkillRoots(targetRepo)
  await moveMissingEntries(
    join(targetRepo, LEGACY_AGENT_SKILLS_DIR),
    join(targetRepo, AGENTS_SKILLS_DIR),
  )
  try {
    await rmdir(join(targetRepo, '.agent'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
  }
}

/**
 * Move a pre-canonical-layout `.claude` install into `.agents` without losing
 * local edits or the pristine merge base. Returns the migrated live bytes.
 */
export async function migrateLegacySkill(
  targetRepo: string,
  installName: string,
  warning?: (line: string) => void,
): Promise<string | undefined> {
  // When the roots are aliases, `.claude` is not a legacy copy: it is the
  // canonical live and pristine tree viewed through another path.
  if (await prepareAliasedSkillRoots(targetRepo)) return undefined

  let migrated: string | undefined
  if ((await readIfExists(installedSkillPath(targetRepo, installName))) === undefined) {
    const legacy = await readIfExists(legacyInstalledSkillPath(targetRepo, installName))
    if (legacy !== undefined) {
      const legacyDir = dirname(legacyInstalledSkillPath(targetRepo, installName))
      const live = installedSkillPath(targetRepo, installName)
      await mkdir(dirname(dirname(live)), { recursive: true })
      await cp(legacyDir, dirname(live), { recursive: true })
      // The complete directory now lives under `.agents`; clear the old
      // discovery location so ensureClaudeSkillLink can replace it.
      await rm(legacyDir, { recursive: true, force: true })
      migrated = legacy
    }
  }

  const legacyPristineDir = dirname(legacyPristineSkillPath(targetRepo, installName))
  try {
    const stat = await lstat(legacyPristineDir)
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await moveMissingEntries(
        legacyPristineDir,
        dirname(pristineSkillPath(targetRepo, installName)),
      )
      try {
        await rmdir(join(targetRepo, CLAUDE_SKILLS_DIR, PRISTINE_DIR))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
      }
      try {
        await lstat(legacyPristineDir)
        warning?.(
          `${installName}: warning — conflicting legacy pristine files remain at ` +
            `${relative(targetRepo, legacyPristineDir)} for manual recovery`,
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return migrated
}

/** Installed `ab-*` skill directories under `.agents/skills`, sorted. */
export async function listInstalledSkills(targetRepo: string): Promise<string[]> {
  const dir = join(targetRepo, AGENTS_SKILLS_DIR)
  let entries: Dirent[]
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

/** Write one live skill file and create its parent directories. */
export async function writeInstalledSkillFile(
  targetRepo: string,
  installName: string,
  file: string,
  content: string,
): Promise<void> {
  const live = installedSkillFilePath(targetRepo, installName, file)
  await mkdir(dirname(live), { recursive: true })
  await writeFile(live, content)
}

/** Write one pristine skill file and create its parent directories. */
export async function writePristineFile(
  targetRepo: string,
  installName: string,
  file: string,
  content: string,
): Promise<void> {
  const pristine = pristineSkillFilePath(targetRepo, installName, file)
  await mkdir(dirname(pristine), { recursive: true })
  await writeFile(pristine, content)
}

/** Write a skill's complete distributed tree and Claude discovery link. */
export async function installSkillTree(
  targetRepo: string,
  skill: Pick<DistSkill, 'installName' | 'files'>,
): Promise<void> {
  for (const file of skill.files) {
    await writeInstalledSkillFile(targetRepo, skill.installName, file.path, file.content)
    await writePristineFile(targetRepo, skill.installName, file.path, file.content)
  }
  await ensureClaudeSkillLink(targetRepo, skill.installName)
}

/** Backward-compatible SKILL.md-only install helper. */
export async function installSkillFiles(
  targetRepo: string,
  installName: string,
  content: string,
): Promise<void> {
  await installSkillTree(targetRepo, {
    installName,
    files: [{ path: 'SKILL.md', content }],
  })
}

/** Update only the pristine SKILL.md record for a skill. */
export async function writePristine(
  targetRepo: string,
  installName: string,
  content: string,
): Promise<void> {
  await writePristineFile(targetRepo, installName, 'SKILL.md', content)
}

export type InitSkillAction = 'installed' | 'kept' | 'unchanged' | 'overwritten'
export type InitConfigAction = 'written' | 'skipped'

export interface SkillDiscoveryConflict {
  skill: string
  message: string
}

export interface InitReport {
  /** What happened to autobuild.toml. */
  config: InitConfigAction
  /** Per-skill outcome, keyed by the namespaced install name. */
  skills: Array<{ skill: string; action: InitSkillAction }>
  /** Distinct Claude directories that prevented discovery-link maintenance. */
  discoveryConflicts: SkillDiscoveryConflict[]
  /** Interactive setup child status, or one when discovery conflicts remain. */
  exitCode: number
}

function setupPrompt(configExists: boolean): string {
  const preface = configExists
    ? 'Review and improve the existing autobuild.toml. Preserve intentional repository choices; do not replace it with a generic template.'
    : 'Complete the new minimal autobuild.toml skeleton using this repository and the user as your sources of truth.'
  return (
    `${preface}\n\n` +
    'Read .agents/skills/ab-guide/references/setup.md and follow it to configure Autobuild for this repository.\n'
  )
}

function renderSkeleton(template: string, runtime: string): string {
  const token = '@ab-init/runtime@'
  const occurrences = template.split(token).length - 1
  // Test/plugin distributions from before agent-driven init can still carry an
  // explicit runtime. Preserve those valid templates rather than making skill
  // installation depend on a newly introduced rendering token.
  if (occurrences === 0) return template
  if (occurrences !== 1) {
    throw new Error(`autobuild.toml template must contain at most one ${token} token`)
  }
  return template.replace(token, runtime)
}

export async function abInit(opts: {
  targetRepo: string
  distRoot?: string
  stdout?: (line: string) => void
  force?: boolean
  runtimes?: RuntimeRegistry
  env?: Readonly<Record<string, string | undefined>>
  interactive?: boolean
  launcher?: SetupAgentLauncher
  signal?: AbortSignal
}): Promise<InitReport> {
  const distRoot = opts.distRoot ?? defaultDistRoot()
  const stdout = opts.stdout ?? (() => {})
  const force = opts.force ?? false
  const env = opts.env ?? process.env
  const runtimes = opts.runtimes ?? createProductionRuntimes().runtimes
  const configPath = join(opts.targetRepo, 'autobuild.toml')
  const configExists = (await readIfExists(configPath)) !== undefined
  const probes = await probeInitRuntimes(runtimes, opts.targetRepo, env)
  const selectedRuntime = selectSetupRuntime(probes)
  const skeletonRuntime = selectedRuntime ?? SETUP_RUNTIME_PREFERENCE[0]

  await migrateLegacyAgentSkills(opts.targetRepo)

  let config: InitConfigAction
  if (!configExists) {
    const template = await readFile(join(distRoot, 'templates', 'autobuild.toml'), 'utf8')
    await mkdir(opts.targetRepo, { recursive: true })
    await writeFile(configPath, renderSkeleton(template, skeletonRuntime))
    config = 'written'
  } else {
    config = 'skipped'
  }

  await ensureLocalStateIgnored(opts.targetRepo)

  const attention: string[] = []
  const discoveryConflictMap = new Map<string, SkillDiscoveryConflict>()
  const containDiscoveryConflict = (error: unknown): void => {
    if (!(error instanceof ClaudeSkillDiscoveryConflict)) throw error
    discoveryConflictMap.set(error.skill, { skill: error.skill, message: error.message })
  }
  const skills: InitReport['skills'] = []
  for (const skill of await readDistSkills(distRoot)) {
    const migrated = await migrateLegacySkill(opts.targetRepo, skill.installName, (line) => {
      attention.push(line)
    })
    const rootLocal =
      migrated ?? (await readIfExists(installedSkillPath(opts.targetRepo, skill.installName)))
    let divergent = false
    for (const file of skill.files) {
      const livePath = installedSkillFilePath(opts.targetRepo, skill.installName, file.path)
      const local =
        file.path === 'SKILL.md' && migrated !== undefined ? migrated : await readIfExists(livePath)
      if (local === undefined || local === file.content) {
        await writeInstalledSkillFile(opts.targetRepo, skill.installName, file.path, file.content)
        await writePristineFile(opts.targetRepo, skill.installName, file.path, file.content)
      } else if (force) {
        divergent = true
        await writeInstalledSkillFile(opts.targetRepo, skill.installName, file.path, file.content)
        await writePristineFile(opts.targetRepo, skill.installName, file.path, file.content)
      } else {
        divergent = true
      }
    }
    const action: InitSkillAction = divergent
      ? force
        ? 'overwritten'
        : 'kept'
      : rootLocal === undefined
        ? 'installed'
        : 'unchanged'
    try {
      await ensureClaudeSkillLink(opts.targetRepo, skill.installName)
    } catch (error) {
      containDiscoveryConflict(error)
    }
    skills.push({ skill: skill.installName, action })
    if (action === 'kept' || action === 'overwritten')
      attention.push(`${skill.installName}: ${action}`)
  }

  for (const name of await listInstalledSkills(opts.targetRepo)) {
    if (discoveryConflictMap.has(name)) continue
    try {
      await ensureClaudeSkillLink(opts.targetRepo, name)
    } catch (error) {
      containDiscoveryConflict(error)
    }
  }
  const discoveryConflicts = [...discoveryConflictMap.values()]

  const skillCounts: Record<InitSkillAction, number> = {
    installed: 0,
    unchanged: 0,
    kept: 0,
    overwritten: 0,
  }
  for (const skill of skills) skillCounts[skill.action] += 1

  stdout(`autobuild.toml: ${config}`)
  stdout(
    `Skills: ${skillCounts.installed} installed, ${skillCounts.unchanged} unchanged, ` +
      `${skillCounts.kept} kept, ${skillCounts.overwritten} overwritten`,
  )
  for (const line of attention) stdout(line)
  if (discoveryConflicts.length > 0) {
    stdout('Claude discovery conflicts:')
    for (const conflict of discoveryConflicts) stdout(`  ${conflict.message}`)
  }
  stdout('')
  stdout('Runtime probes:')
  for (const probe of probes) {
    stdout(`  ${probe.runtime}: ${probe.usable ? 'usable' : 'unusable'} — ${probe.reason}`)
  }

  if (discoveryConflicts.length > 0) {
    return { config, skills, discoveryConflicts, exitCode: 1 }
  }

  // The handoff is deliberately a stable pointer rather than embedded guide
  // content. Installation remains successful for an older or partial
  // distribution whose guide tree does not contain the reference yet.
  const prompt = setupPrompt(configExists)
  if (selectedRuntime !== undefined && opts.interactive === true) {
    stdout('')
    stdout(`Starting setup agent with ${selectedRuntime}…`)
    const exitCode = await (opts.launcher ?? launchSetupAgent)({
      runtime: selectedRuntime,
      prompt,
      cwd: opts.targetRepo,
      env,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    })
    return { config, skills, discoveryConflicts, exitCode }
  }

  stdout('')
  stdout(
    selectedRuntime === undefined
      ? 'No usable interactive runtime was detected. Run the following prompt in a coding agent:'
      : 'No interactive terminal was detected. Run the following prompt in a coding agent:',
  )
  stdout(prompt)
  return { config, skills, discoveryConflicts, exitCode: 0 }
}
