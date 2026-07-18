/**
 * `ab init` — vendor the canonical default skills into a repo (SPEC §16.3,
 * D11). Copies, not references: per-repo customization is the point, so each
 * skill lands in the Agent Skills standard `.agents/skills/ab-<name>/SKILL.md`
 * where the repo may edit it freely. Pi discovers that project directory
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
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { installedSkillName, SKILL_NAMESPACE } from '../skills'

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

/** Live install path: `<target>/.agents/skills/ab-<name>/SKILL.md`. */
export function installedSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, AGENTS_SKILLS_DIR, installName, 'SKILL.md')
}

/** Claude discovery path: a directory symlink to the live `.agents` skill. */
export function claudeSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, CLAUDE_SKILLS_DIR, installName)
}

/** Pristine record: `<target>/.agents/skills/.ab-pristine/ab-<name>/SKILL.md`. */
export function pristineSkillPath(targetRepo: string, installName: string): string {
  return join(targetRepo, AGENTS_SKILLS_DIR, PRISTINE_DIR, installName, 'SKILL.md')
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

const PACKAGE_COMMANDS_ANCHOR = '# @ab-init/package-script-commands'
const PACKAGE_VERIFY_STEPS_ANCHOR = '# @ab-init/package-script-verify-steps'
const PACKAGE_VERIFY_TABLES_ANCHOR = '# @ab-init/package-script-verify-tables'

/** Exact root-package script names that may contribute fresh config. */
const PACKAGE_SCRIPT_CONFIG = [
  { script: 'lint', command: 'lint', shell: 'bun run lint' },
  {
    script: 'type-check',
    command: 'typecheck',
    shell: 'bun run type-check',
    verify: 'types',
  },
  { script: 'test', command: 'test', shell: 'bun run test', verify: 'unit' },
] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Inspect only the target repository's root manifest. Missing package metadata
 * means there are no package-backed commands; malformed metadata must not be
 * mistaken for a successful empty detection.
 */
export async function detectInitPackageScripts(targetRepo: string): Promise<Set<string>> {
  const manifestPath = join(targetRepo, 'package.json')
  let source: string | undefined
  try {
    source = await readIfExists(manifestPath)
  } catch (error) {
    throw new Error(`${manifestPath}: unable to read package manifest: ${errorMessage(error)}`)
  }
  if (source === undefined) return new Set()

  let manifest: unknown
  try {
    manifest = JSON.parse(source)
  } catch (error) {
    throw new Error(`${manifestPath}: invalid JSON: ${errorMessage(error)}`)
  }

  const scripts = isRecord(manifest) ? manifest.scripts : undefined
  if (!isRecord(scripts)) return new Set()

  const detected = new Set<string>()
  for (const descriptor of PACKAGE_SCRIPT_CONFIG) {
    if (!Object.hasOwn(scripts, descriptor.script)) continue
    const declaration = scripts[descriptor.script]
    if (typeof declaration !== 'string' || declaration.trim() === '') {
      throw new Error(
        `${manifestPath}: package script "${descriptor.script}" must be a non-empty string`,
      )
    }
    detected.add(descriptor.script)
  }
  return detected
}

function replaceTemplateAnchor(
  template: string,
  anchor: string,
  replacement: string,
): string {
  const occurrences = template.split(anchor).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `autobuild.toml template anchor "${anchor}" must occur exactly once; found ${occurrences}`,
    )
  }
  const line = `${anchor}\n`
  if (!template.includes(line)) {
    throw new Error(`autobuild.toml template anchor "${anchor}" must occupy its own line`)
  }
  return template.replace(line, replacement === '' ? '' : `${replacement}\n`)
}

/**
 * Render package-backed commands and their matching checks into the valid,
 * setup-only template baseline. Fixed descriptors and strict anchor counts
 * make every script subset deterministic and make template drift fail loudly.
 */
export function renderAutobuildTemplate(
  template: string,
  detectedScripts: ReadonlySet<string>,
): string {
  const enabled = PACKAGE_SCRIPT_CONFIG.filter(({ script }) => detectedScripts.has(script))
  const commands = enabled
    .map(({ command, shell }) => `${command} = "${shell}"`)
    .join('\n')
  const checks = enabled.flatMap((descriptor) =>
    'verify' in descriptor
      ? [{ step: descriptor.verify, command: descriptor.command }]
      : [],
  )
  const verifySteps = checks.map(({ step }) => `  "${step}",`).join('\n')
  const verifyTables = checks
    .map(
      ({ step, command }) =>
        `[verify.${step}]\nkind = "check"\ncommand = "${command}"`,
    )
    .join('\n\n')

  let rendered = replaceTemplateAnchor(template, PACKAGE_COMMANDS_ANCHOR, commands)
  rendered = replaceTemplateAnchor(rendered, PACKAGE_VERIFY_STEPS_ANCHOR, verifySteps)
  return replaceTemplateAnchor(rendered, PACKAGE_VERIFY_TABLES_ANCHOR, verifyTables)
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
    .map((line) =>
      line.startsWith('name:') ? `name: ${installedSkillName(skillName)}` : line,
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
      installName: installedSkillName(entry.name),
      content: rewriteSkillSource(source, entry.name),
    })
  }
  return skills
}

/** Ensure Claude discovers the canonical `.agents` skill through a symlink. */
export async function ensureClaudeSkillLink(
  targetRepo: string,
  installName: string,
): Promise<void> {
  const link = claudeSkillPath(targetRepo, installName)
  const target = dirname(installedSkillPath(targetRepo, installName))
  await mkdir(dirname(link), { recursive: true })

  try {
    const stat = await lstat(link)
    if (stat.isSymbolicLink()) {
      const current = resolve(dirname(link), await readlink(link))
      if (current === resolve(target)) return
      await unlink(link)
    } else {
      throw new Error(
        `cannot create Claude link for "${installName}": ${CLAUDE_SKILLS_DIR}/${installName} ` +
          `is a real directory while ${AGENTS_SKILLS_DIR}/${installName} already exists`,
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
  let entries
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
    let destinationStat
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
): Promise<string | undefined> {
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

  const legacyPristinePath = legacyPristineSkillPath(targetRepo, installName)
  const legacyPristine = await readIfExists(legacyPristinePath)
  if (legacyPristine !== undefined) {
    if ((await readIfExists(pristineSkillPath(targetRepo, installName))) === undefined) {
      await writePristine(targetRepo, installName, legacyPristine)
    }
    await rm(dirname(legacyPristinePath), { recursive: true, force: true })
    try {
      await rmdir(join(targetRepo, CLAUDE_SKILLS_DIR, PRISTINE_DIR))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
    }
  }
  return migrated
}

/** Installed `ab-*` skill directories under `.agents/skills`, sorted. */
export async function listInstalledSkills(targetRepo: string): Promise<string[]> {
  const dir = join(targetRepo, AGENTS_SKILLS_DIR)
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

/** Write a skill's live copy, pristine record, and Claude discovery link. */
export async function installSkillFiles(
  targetRepo: string,
  installName: string,
  content: string,
): Promise<void> {
  const live = installedSkillPath(targetRepo, installName)
  await mkdir(dirname(live), { recursive: true })
  await writeFile(live, content)
  await writePristine(targetRepo, installName, content)
  await ensureClaudeSkillLink(targetRepo, installName)
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

  // Older releases used `.agent/skills`, which Pi does not discover. Move the
  // complete tree before inspecting or writing any skills.
  await migrateLegacyAgentSkills(opts.targetRepo)

  // Render autobuild.toml only when it is absent (§16.3). Package inspection
  // deliberately stays inside this branch: the repo's config is the repo's
  // from the very first re-run, even if package scripts later change.
  const configPath = join(opts.targetRepo, 'autobuild.toml')
  let config: InitConfigAction
  if ((await readIfExists(configPath)) === undefined) {
    const template = await readFile(join(distRoot, 'templates', 'autobuild.toml'), 'utf8')
    const detectedScripts = await detectInitPackageScripts(opts.targetRepo)
    const rendered = renderAutobuildTemplate(template, detectedScripts)
    await mkdir(opts.targetRepo, { recursive: true })
    await writeFile(configPath, rendered)
    config = 'written'
  } else {
    config = 'skipped'
  }
  stdout(`autobuild.toml: ${config}`)

  // State is repository-local by default and must never appear as source.
  // This append-only/idempotent update preserves every user-authored rule.
  await ensureLocalStateIgnored(opts.targetRepo)

  const skills: InitReport['skills'] = []
  for (const skill of await readDistSkills(distRoot)) {
    const migrated = await migrateLegacySkill(opts.targetRepo, skill.installName)
    const local =
      migrated ?? (await readIfExists(installedSkillPath(opts.targetRepo, skill.installName)))
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
    await ensureClaudeSkillLink(opts.targetRepo, skill.installName)
    stdout(`${skill.installName}: ${action}`)
    skills.push({ skill: skill.installName, action })
  }

  // Migration considers the complete old tree, including local additions
  // unknown to this distribution. Keep their Claude discovery links valid too.
  for (const name of await listInstalledSkills(opts.targetRepo)) {
    await ensureClaudeSkillLink(opts.targetRepo, name)
  }
  return { config, skills }
}
