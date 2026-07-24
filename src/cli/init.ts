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
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { installedSkillName, SKILL_NAMESPACE } from '../skills'
import { INIT_PLUGIN_HELP, type InitPromptChoice, type InitPrompter } from './init-prompt'

export { SKILL_NAMESPACE }

export type InitTicketSource = 'file' | 'linear'
export type InitWorkspaceProvider = 'git-worktree'
export type InitRoleProfile = 'split' | 'claude' | 'pi'

export const INIT_SPLIT_AUTHOR_MODEL = 'openai-codex/gpt-5.6-sol'
export const INIT_SPLIT_REVIEWER_MODEL = 'kimi-coding/k3'

export const INIT_TICKET_SOURCE_CHOICES = [
  {
    value: 'file',
    label: 'Local file tracker',
    help: 'Stores markdown tickets locally under .autobuild/tickets; no account or secret required.',
  },
  {
    value: 'linear',
    label: 'Linear',
    help: 'Uses Linear; you will set team/workflow fields and LINEAR_API_KEY after init.',
  },
] as const satisfies readonly InitPromptChoice<InitTicketSource>[]

export const INIT_WORKSPACE_PROVIDER_CHOICES = [
  {
    value: 'git-worktree',
    label: 'Git worktree',
    help: 'Uses the shipped local git-worktree workspace provider; no infrastructure required.',
  },
] as const satisfies readonly InitPromptChoice<InitWorkspaceProvider>[]

export const INIT_ROLE_PROFILE_CHOICES = [
  {
    value: 'split',
    label: 'Independent author/reviewer models',
    help: `Pi runs plan + implement on ${INIT_SPLIT_AUTHOR_MODEL}, and both review roles on ${INIT_SPLIT_REVIEWER_MODEL}.`,
  },
  {
    value: 'claude',
    label: 'Claude default',
    help: "Uses the Claude runtime's own default model for every role (the historical template default).",
  },
  {
    value: 'pi',
    label: 'Pi default',
    help: "Uses the Pi runtime's own default model for every role.",
  },
] as const satisfies readonly InitPromptChoice<InitRoleProfile>[]

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

function replaceTemplateAnchor(template: string, anchor: string, replacement: string): string {
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
  const commands = enabled.map(({ command, shell }) => `${command} = "${shell}"`).join('\n')
  const checks = enabled.flatMap((descriptor) =>
    'verify' in descriptor ? [{ step: descriptor.verify, command: descriptor.command }] : [],
  )
  const verifySteps = checks.map(({ step }) => `  "${step}",`).join('\n')
  const verifyTables = checks
    .map(({ step, command }) => `[verify.${step}]\nkind = "check"\ncommand = "${command}"`)
    .join('\n\n')

  let rendered = replaceTemplateAnchor(template, PACKAGE_COMMANDS_ANCHOR, commands)
  rendered = replaceTemplateAnchor(rendered, PACKAGE_VERIFY_STEPS_ANCHOR, verifySteps)
  return replaceTemplateAnchor(rendered, PACKAGE_VERIFY_TABLES_ANCHOR, verifyTables)
}

export interface InitSelectionInput {
  ticketSource?: string
  workspaceProvider?: string
  roleProfile?: string
  noInteractive?: boolean
}

export interface ResolvedInitSelections {
  ticketSource: InitTicketSource
  workspaceProvider: InitWorkspaceProvider
  roleProfile: InitRoleProfile
}

function selectionValue<T extends string>(
  surface: string,
  raw: string,
  choices: readonly InitPromptChoice<T>[],
): T {
  const choice = choices.find((candidate) => candidate.value === raw)
  if (choice !== undefined) return choice.value
  throw new Error(
    `invalid --${surface} value "${raw}" — expected ${choices
      .map((candidate) => candidate.value)
      .join('|')}`,
  )
}

async function resolveInitSelections(
  input: InitSelectionInput,
  prompter?: InitPrompter,
): Promise<ResolvedInitSelections> {
  const supplied =
    input.ticketSource !== undefined ||
    input.workspaceProvider !== undefined ||
    input.roleProfile !== undefined
  if (input.noInteractive === true && supplied) {
    throw new Error(
      '--no-interactive cannot be combined with --ticket-source, --workspace-provider, or --role-profile',
    )
  }

  const canPrompt = input.noInteractive !== true && prompter !== undefined
  const ticketSource =
    input.ticketSource !== undefined
      ? selectionValue('ticket-source', input.ticketSource, INIT_TICKET_SOURCE_CHOICES)
      : canPrompt
        ? await prompter.select({
            message: 'Choose a ticket source',
            help: INIT_PLUGIN_HELP,
            choices: INIT_TICKET_SOURCE_CHOICES,
            defaultValue: 'file',
          })
        : 'file'
  const workspaceProvider =
    input.workspaceProvider !== undefined
      ? selectionValue(
          'workspace-provider',
          input.workspaceProvider,
          INIT_WORKSPACE_PROVIDER_CHOICES,
        )
      : canPrompt
        ? await prompter.select({
            message: 'Choose a workspace provider',
            help: INIT_PLUGIN_HELP,
            choices: INIT_WORKSPACE_PROVIDER_CHOICES,
            defaultValue: 'git-worktree',
          })
        : 'git-worktree'
  const roleProfile =
    input.roleProfile !== undefined
      ? selectionValue('role-profile', input.roleProfile, INIT_ROLE_PROFILE_CHOICES)
      : canPrompt
        ? await prompter.select({
            message: 'Choose a role runtime/model arrangement',
            help: INIT_PLUGIN_HELP,
            choices: INIT_ROLE_PROFILE_CHOICES,
            defaultValue: 'split',
          })
        : 'claude'
  return { ticketSource, workspaceProvider, roleProfile }
}

function replaceSelectionFragment(rendered: string, current: string, replacement: string): string {
  const occurrences = rendered.split(current).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `autobuild.toml selection fragment must occur exactly once; found ${occurrences}: ${JSON.stringify(current)}`,
    )
  }
  return rendered.replace(current, replacement)
}

/** Apply only explicitly different adapter/profile selections to the baseline. */
export function renderInitSelections(baseline: string, selections: ResolvedInitSelections): string {
  let rendered = baseline
  if (selections.ticketSource === 'linear') {
    rendered = replaceSelectionFragment(rendered, 'source = "file"', 'source = "linear"')
    rendered = replaceSelectionFragment(
      rendered,
      'readyState = "ready"',
      'readyState = "REPLACE_WITH_LINEAR_READY_STATE"',
    )
    rendered = replaceSelectionFragment(
      rendered,
      '# To use Linear, change source above and add the following. The API key is a\n' +
        '# secret: set LINEAR_API_KEY in the environment (a local .env works), never here.\n' +
        '#teamKey = "ENG"                 # Linear team key (required)',
      '# Linear selected by ab init. Replace this required non-secret placeholder.\n' +
        '# Keep the API key in LINEAR_API_KEY (a local .env works), never in this file.\n' +
        'teamKey = "REPLACE_WITH_LINEAR_TEAM_KEY"',
    )
  }

  const claudeRole =
    '[roles.default]\nruntime = "claude"   # no configured model ⇒ this runtime\'s own default'
  if (selections.roleProfile === 'pi') {
    rendered = replaceSelectionFragment(
      rendered,
      claudeRole,
      '[roles.default]\nruntime = "pi"       # no configured model ⇒ this runtime\'s own default',
    )
  } else if (selections.roleProfile === 'split') {
    rendered = replaceSelectionFragment(
      rendered,
      claudeRole,
      `[roles.plan]\nruntime = "pi"\nmodel = "${INIT_SPLIT_AUTHOR_MODEL}"\n\n` +
        `[roles.implement]\nruntime = "pi"\nmodel = "${INIT_SPLIT_AUTHOR_MODEL}"\n\n` +
        `[roles.plan-review]\nruntime = "pi"\nmodel = "${INIT_SPLIT_REVIEWER_MODEL}"\n\n` +
        `[roles.code-review]\nruntime = "pi"\nmodel = "${INIT_SPLIT_REVIEWER_MODEL}"`,
    )
  }
  return rendered
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
  selections?: InitSelectionInput
  prompter?: InitPrompter
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
  let resolvedSelections: ResolvedInitSelections | undefined
  if ((await readIfExists(configPath)) === undefined) {
    try {
      resolvedSelections = await resolveInitSelections(opts.selections ?? {}, opts.prompter)
    } finally {
      opts.prompter?.close?.()
    }
    const template = await readFile(join(distRoot, 'templates', 'autobuild.toml'), 'utf8')
    const detectedScripts = await detectInitPackageScripts(opts.targetRepo)
    const baseline = renderAutobuildTemplate(template, detectedScripts)
    const rendered = renderInitSelections(baseline, resolvedSelections)
    await mkdir(opts.targetRepo, { recursive: true })
    await writeFile(configPath, rendered)
    config = 'written'
  } else {
    config = 'skipped'
  }
  stdout(`autobuild.toml: ${config}`)
  if (config === 'written' && resolvedSelections?.ticketSource === 'linear') {
    stdout(
      'Linear setup required: replace [tickets].teamKey and [tickets].readyState, then set LINEAR_API_KEY in the environment (never in autobuild.toml).',
    )
  }
  if (
    config === 'written' &&
    (resolvedSelections?.roleProfile === 'split' || resolvedSelections?.roleProfile === 'pi')
  ) {
    stdout(
      'Pi setup required: authenticate the providers used by your selected role profile — run `pi` and use `/login`, or set the provider API key in the environment.',
    )
  }

  // State is repository-local by default and must never appear as source.
  // This append-only/idempotent update preserves every user-authored rule.
  await ensureLocalStateIgnored(opts.targetRepo)

  const skills: InitReport['skills'] = []
  for (const skill of await readDistSkills(distRoot)) {
    const migrated = await migrateLegacySkill(opts.targetRepo, skill.installName, stdout)
    const rootLocal =
      migrated ?? (await readIfExists(installedSkillPath(opts.targetRepo, skill.installName)))
    let divergent = false
    for (const file of skill.files) {
      const livePath = installedSkillFilePath(opts.targetRepo, skill.installName, file.path)
      const local =
        file.path === 'SKILL.md' && migrated !== undefined ? migrated : await readIfExists(livePath)
      if (local === undefined || local === file.content) {
        // Missing distributed files are added independently. Equality proves
        // refreshing (or self-healing) their pristine base is safe.
        await writeInstalledSkillFile(opts.targetRepo, skill.installName, file.path, file.content)
        await writePristineFile(opts.targetRepo, skill.installName, file.path, file.content)
      } else if (force) {
        divergent = true
        await writeInstalledSkillFile(opts.targetRepo, skill.installName, file.path, file.content)
        await writePristineFile(opts.targetRepo, skill.installName, file.path, file.content)
      } else {
        // Local edits are NEVER clobbered by init (§16.3), even when SKILL.md
        // is missing. Other files in the tree are handled independently.
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
