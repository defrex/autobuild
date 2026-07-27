import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { inc as incrementSemver, valid as validSemver } from 'semver'

export const README_INSTALL_START = '<!-- release-install:start -->'
export const README_INSTALL_END = '<!-- release-install:end -->'

export type VersionBump = 'major' | 'minor' | 'patch'

export interface ReleaseArguments {
  dryRun: boolean
  version?: string
  bump?: VersionBump
}

export interface CommandRequest {
  command: string
  args: readonly string[]
  cwd: string
  stdin?: string
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>

export interface ReleaseOutput {
  log(message: string): void
  warn(message: string): void
}

export interface ReleaseDependencies {
  run?: CommandRunner
  output?: ReleaseOutput
  today?: () => string
}

export interface ChangelogRelease {
  content: string
  cutSection: string
  entries: string
}

interface ReleaseConfig {
  baseBranch: string
  commands: {
    lint: string
    typecheck: string
    test: string
  }
}

const defaultOutput: ReleaseOutput = {
  log: (message) => console.log(message),
  warn: (message) => console.error(`WARNING: ${message}`),
}

function valueAfter(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parseReleaseArguments(args: readonly string[]): ReleaseArguments {
  let dryRun = false
  let version: string | undefined
  let bump: VersionBump | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    switch (argument) {
      case '--dry-run':
        if (dryRun) throw new Error('--dry-run may be supplied only once')
        dryRun = true
        break
      case '--version':
        if (version !== undefined) throw new Error('--version may be supplied only once')
        version = valueAfter(args, index, '--version')
        index += 1
        break
      case '--major':
      case '--minor':
      case '--patch': {
        if (bump !== undefined) throw new Error('choose only one of --major, --minor, or --patch')
        bump = argument.slice(2) as VersionBump
        break
      }
      default:
        throw new Error(`unknown argument: ${argument}`)
    }
  }

  const selectorCount = Number(version !== undefined) + Number(bump !== undefined)
  if (selectorCount !== 1) {
    throw new Error(
      'choose exactly one version selector: --version <semver>, --major, --minor, or --patch',
    )
  }
  return {
    dryRun,
    ...(version === undefined ? {} : { version }),
    ...(bump === undefined ? {} : { bump }),
  }
}

export function resolveReleaseVersion(
  currentVersion: string,
  arguments_: ReleaseArguments,
): string {
  if (validSemver(currentVersion) === null) {
    throw new Error(`package.json version is not valid semver: ${currentVersion}`)
  }
  if (arguments_.version !== undefined) {
    const version = validSemver(arguments_.version)
    if (version === null || version !== arguments_.version) {
      throw new Error(`--version must be an exact semver version: ${arguments_.version}`)
    }
    return version
  }
  if (arguments_.bump === undefined) {
    throw new Error('no version selector was supplied')
  }
  const version = incrementSemver(currentVersion, arguments_.bump)
  if (version === null) {
    throw new Error(`could not apply --${arguments_.bump} to ${currentVersion}`)
  }
  return version
}

function unreleasedHeadingMatches(content: string): number[] {
  const matches: number[] = []
  for (const match of content.matchAll(/^## Unreleased[\t ]*$/gm)) {
    if (match.index !== undefined) matches.push(match.index)
  }
  return matches
}

function endOfLine(content: string, start: number): number {
  const newline = content.indexOf('\n', start)
  return newline === -1 ? content.length : newline + 1
}

export function unreleasedEntries(changelog: string): string {
  const headings = unreleasedHeadingMatches(changelog)
  if (headings.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one "## Unreleased" heading (found ${headings.length})`,
    )
  }
  const bodyStart = endOfLine(changelog, headings[0] ?? 0)
  const nextHeadingMatch = /^## .+$/gm
  nextHeadingMatch.lastIndex = bodyStart
  const nextHeading = nextHeadingMatch.exec(changelog)
  const bodyEnd = nextHeading?.index ?? changelog.length
  const entries = changelog.slice(bodyStart, bodyEnd)
  if (entries.trim().length === 0) {
    throw new Error('CHANGELOG.md Unreleased section has no entries')
  }
  return entries
}

function trimBlankEdges(value: string): string {
  return value.replace(/^(?:[\t ]*\r?\n)+/, '').replace(/(?:\r?\n[\t ]*)+$/, '')
}

export function renderReleasedChangelog(
  changelog: string,
  tag: string,
  date: string,
  summary?: string,
): ChangelogRelease {
  const headings = unreleasedHeadingMatches(changelog)
  if (headings.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one "## Unreleased" heading (found ${headings.length})`,
    )
  }
  const headingStart = headings[0] ?? 0
  const bodyStart = endOfLine(changelog, headingStart)
  const nextHeadingMatch = /^## .+$/gm
  nextHeadingMatch.lastIndex = bodyStart
  const nextHeading = nextHeadingMatch.exec(changelog)
  const bodyEnd = nextHeading?.index ?? changelog.length
  const rawEntries = changelog.slice(bodyStart, bodyEnd)
  const entries = trimBlankEdges(rawEntries)
  if (entries.trim().length === 0) {
    throw new Error('CHANGELOG.md Unreleased section has no entries')
  }

  const prefix = changelog.slice(0, bodyStart)
  const suffix = changelog.slice(bodyEnd)
  const cutSection = `## ${tag} — ${date}\n\n${summary === undefined ? '' : `${summary}\n\n`}${entries}\n`
  const suffixSeparator = suffix.length === 0 ? '' : '\n'
  const content = `${prefix}\n${cutSection}${suffixSeparator}${suffix}`

  const resultHeadings = unreleasedHeadingMatches(content)
  if (resultHeadings.length !== 1)
    throw new Error('rendered changelog lost its single Unreleased heading')
  const resultBodyStart = endOfLine(content, resultHeadings[0] ?? 0)
  const resultNextHeading = /^## .+$/gm
  resultNextHeading.lastIndex = resultBodyStart
  const resultBodyEnd = resultNextHeading.exec(content)?.index ?? content.length
  if (content.slice(resultBodyStart, resultBodyEnd).trim().length !== 0) {
    throw new Error('rendered changelog did not leave an empty Unreleased section')
  }
  if (!content.includes(cutSection))
    throw new Error('rendered changelog lost the cut release section')

  return { content, cutSection, entries }
}

export function normalizeClaudeSummary(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 1_200) return undefined
  if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|>\s?)/m.test(trimmed)) return undefined
  const paragraph = trimmed.replace(/\s+/g, ' ')
  if (paragraph.length < 20 || !/[.!?]$/.test(paragraph)) return undefined
  return paragraph
}

export function replaceReadmeInstall(readme: string, tag: string): string {
  const starts = readme.split(README_INSTALL_START).length - 1
  const ends = readme.split(README_INSTALL_END).length - 1
  if (starts !== 1 || ends !== 1) {
    throw new Error(
      `README.md must contain exactly one ${README_INSTALL_START}/${README_INSTALL_END} marker pair`,
    )
  }
  const start = readme.indexOf(README_INSTALL_START)
  const end = readme.indexOf(README_INSTALL_END)
  if (end <= start) throw new Error('README.md release-install markers are out of order')
  const replacement = `${README_INSTALL_START}\n\n\`\`\`sh\nbun add -g github:defrex/autobuild#${tag}\n\`\`\`\n\n`
  return `${readme.slice(0, start)}${replacement}${readme.slice(end)}`
}

export function replacePackageVersion(manifestText: string, version: string): string {
  const manifest = JSON.parse(manifestText) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('package.json version must be a string')
  const matches = [...manifestText.matchAll(/^(\s*"version"\s*:\s*")[^"]*("\s*,?\s*)$/gm)]
  if (matches.length !== 1)
    throw new Error('package.json must contain exactly one line-formatted version field')
  const match = matches[0]
  if (match === undefined || match.index === undefined)
    throw new Error('could not locate package.json version field')
  const replacement = `${match[1]}${version}${match[2]}`
  const content = `${manifestText.slice(0, match.index)}${replacement}${manifestText.slice(match.index + match[0].length)}`
  const rendered = JSON.parse(content) as { version?: unknown }
  if (rendered.version !== version) throw new Error('rendered package.json has the wrong version')
  return content
}

function readReleaseConfig(content: string): ReleaseConfig {
  const parsed = parseToml(content) as Record<string, unknown>
  const baseBranch = parsed.baseBranch
  const commands = parsed.commands
  if (typeof baseBranch !== 'string' || baseBranch.trim().length === 0) {
    throw new Error('autobuild.toml baseBranch must be a nonblank string')
  }
  if (typeof commands !== 'object' || commands === null) {
    throw new Error('autobuild.toml [commands] is required')
  }
  const commandMap = commands as Record<string, unknown>
  const required = ['lint', 'typecheck', 'test'] as const
  const configured = {} as ReleaseConfig['commands']
  for (const name of required) {
    const command = commandMap[name]
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error(`autobuild.toml [commands].${name} must be configured for releases`)
    }
    configured[name] = command
  }
  return { baseBranch, commands: configured }
}

export const spawnCommand: CommandRunner = async ({ command, args, cwd, stdin }) => {
  try {
    const child = Bun.spawn([command, ...args], {
      cwd,
      stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { exitCode, stdout, stderr }
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

async function checked(
  run: CommandRunner,
  request: CommandRequest,
  description: string,
): Promise<CommandResult> {
  const result = await run(request)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.exitCode}`
    throw new Error(`${description}: ${detail}`)
  }
  return result
}

async function git(
  run: CommandRunner,
  root: string,
  args: readonly string[],
  description: string,
): Promise<CommandResult> {
  return checked(run, { command: 'git', args, cwd: root }, description)
}

async function localTagExists(run: CommandRunner, root: string, tag: string): Promise<boolean> {
  const result = await checked(
    run,
    { command: 'git', args: ['tag', '--list', tag], cwd: root },
    `could not inspect local tag ${tag}`,
  )
  const tags = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (tags.length > 1 || (tags.length === 1 && tags[0] !== tag)) {
    throw new Error(`local tag lookup for ${tag} returned an unexpected result`)
  }
  return tags.length === 1
}

async function ensureClean(run: CommandRunner, root: string): Promise<void> {
  const status = await git(
    run,
    root,
    ['status', '--porcelain', '--untracked-files=normal'],
    'could not inspect worktree',
  )
  if (status.stdout.length > 0)
    throw new Error('worktree is dirty; commit, stash, or remove changes before releasing')
}

async function restoreBeforePush(
  run: CommandRunner,
  root: string,
  originalHead: string,
  tag: string,
): Promise<void> {
  if (await localTagExists(run, root, tag)) {
    await git(run, root, ['tag', '--delete', tag], `could not remove unpushed local tag ${tag}`)
  }
  await git(
    run,
    root,
    ['reset', '--hard', originalHead],
    'could not restore the pre-release commit',
  )
  await git(run, root, ['clean', '-fd'], 'could not remove untracked release output')
}

function summaryPrompt(entries: string): string {
  return [
    'Write one short prose paragraph summarizing the highlights of this software release.',
    'Use 2-4 sentences, plain prose only: no heading, bullets, Markdown, preamble, or commentary.',
    'Base the summary only on these changelog entries:',
    '',
    entries,
  ].join('\n')
}

async function generateSummary(
  run: CommandRunner,
  root: string,
  entries: string,
  output: ReleaseOutput,
): Promise<string | undefined> {
  const result = await run({
    command: 'claude',
    args: ['-p', '--tools', '', '--', summaryPrompt(entries)],
    cwd: root,
  })
  const summary = result.exitCode === 0 ? normalizeClaudeSummary(result.stdout) : undefined
  if (summary !== undefined) return summary
  const reason =
    result.exitCode !== 0
      ? result.stderr.trim() || `claude exited with status ${result.exitCode}`
      : 'claude returned blank or structurally unusable text'
  output.warn(
    `release summary omitted: ${reason}. The release will continue with all changelog bullets intact.`,
  )
  return undefined
}

function printCandidate(output: ReleaseOutput, path: string, content: string): void {
  output.log(
    `--- ${path} (candidate) ---\n${content}${content.endsWith('\n') ? '' : '\n'}--- end ${path} ---`,
  )
}

function githubReleaseRecoveryCommand(tag: string, notes: string): string {
  const noteLines = new Set(notes.split(/\r?\n/))
  let delimiter = 'AUTOBUILD_RELEASE_NOTES'
  while (noteLines.has(delimiter)) delimiter += '_END'
  const terminatedNotes = notes.endsWith('\n') ? notes : `${notes}\n`
  return `gh release create ${tag} --verify-tag --title ${tag} --notes-file - <<'${delimiter}'\n${terminatedNotes}${delimiter}`
}

export async function runRelease(
  args: readonly string[],
  cwd = process.cwd(),
  dependencies: ReleaseDependencies = {},
): Promise<void> {
  const run = dependencies.run ?? spawnCommand
  const output = dependencies.output ?? defaultOutput
  const today = dependencies.today ?? (() => new Date().toISOString().slice(0, 10))
  const arguments_ = parseReleaseArguments(args)

  const rootResult = await checked(
    run,
    { command: 'git', args: ['rev-parse', '--show-toplevel'], cwd },
    'release command must run inside a Git repository',
  )
  const root = rootResult.stdout.trim()
  const [configText, manifestText, changelogText, readmeText] = await Promise.all([
    readFile(resolve(root, 'autobuild.toml'), 'utf8'),
    readFile(resolve(root, 'package.json'), 'utf8'),
    readFile(resolve(root, 'CHANGELOG.md'), 'utf8'),
    readFile(resolve(root, 'README.md'), 'utf8'),
  ])
  const config = readReleaseConfig(configText)
  const manifest = JSON.parse(manifestText) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('package.json version must be a string')
  const version = resolveReleaseVersion(manifest.version, arguments_)
  const tag = `v${version}`

  await ensureClean(run, root)
  const branch = (
    await git(run, root, ['branch', '--show-current'], 'could not inspect current branch')
  ).stdout.trim()
  if (branch !== config.baseBranch) {
    throw new Error(
      `HEAD is on branch "${branch || '(detached)'}"; release from configured base branch "${config.baseBranch}"`,
    )
  }
  const entries = unreleasedEntries(changelogText)
  if (await localTagExists(run, root, tag))
    throw new Error(`target tag ${tag} already exists locally`)

  const remoteTag = await checked(
    run,
    {
      command: 'git',
      args: ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
      cwd: root,
    },
    `could not inspect remote target tag ${tag}`,
  )
  if (remoteTag.stdout.trim().length > 0)
    throw new Error(`target tag ${tag} already exists on remote origin`)

  const remoteBranch = await checked(
    run,
    {
      command: 'git',
      args: ['ls-remote', '--heads', 'origin', `refs/heads/${config.baseBranch}`],
      cwd: root,
    },
    `could not inspect origin/${config.baseBranch}`,
  )
  const remoteLines = remoteBranch.stdout.trim().split(/\r?\n/).filter(Boolean)
  if (remoteLines.length !== 1)
    throw new Error(`origin/${config.baseBranch} does not resolve to exactly one branch`)
  const remoteSha = remoteLines[0]?.split(/\s+/)[0]
  if (remoteSha === undefined || !/^[0-9a-f]{40}$/i.test(remoteSha)) {
    throw new Error(`origin/${config.baseBranch} returned an invalid commit id`)
  }
  await git(
    run,
    root,
    ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `refs/heads/${config.baseBranch}`],
    `could not fetch origin/${config.baseBranch}`,
  )
  const behindText = (
    await git(
      run,
      root,
      ['rev-list', '--count', `HEAD..${remoteSha}`],
      `could not compare HEAD with origin/${config.baseBranch}`,
    )
  ).stdout.trim()
  const behind = Number.parseInt(behindText, 10)
  if (!Number.isSafeInteger(behind)) throw new Error(`could not parse behind count: ${behindText}`)
  if (behind > 0)
    throw new Error(
      `local ${config.baseBranch} is behind origin/${config.baseBranch} by ${behind} commit(s)`,
    )

  const preGateHead = (
    await git(run, root, ['rev-parse', 'HEAD'], 'could not resolve HEAD')
  ).stdout.trim()
  for (const name of ['lint', 'typecheck', 'test'] as const) {
    output.log(`Running ${name} gate: ${config.commands[name]}`)
    const result = await run({ command: 'sh', args: ['-c', config.commands[name]], cwd: root })
    if (result.stdout.length > 0) output.log(result.stdout.trimEnd())
    if (result.stderr.length > 0) output.warn(result.stderr.trimEnd())
    const gateStatus = await git(
      run,
      root,
      ['status', '--porcelain'],
      'could not inspect gate output',
    )
    if (gateStatus.stdout.length > 0) {
      await restoreBeforePush(run, root, preGateHead, tag)
      throw new Error(
        `${name} quality gate changed the worktree; its output was restored and the release was aborted`,
      )
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `${name} quality gate failed with exit status ${result.exitCode}; no release files were changed`,
      )
    }
  }

  const summary = await generateSummary(run, root, entries, output)
  const date = today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`release date is not YYYY-MM-DD: ${date}`)
  const changelog = renderReleasedChangelog(changelogText, tag, date, summary)
  const readme = replaceReadmeInstall(readmeText, tag)
  const manifestContent = replacePackageVersion(manifestText, version)

  output.log(`Release ${tag} (${date})`)
  output.log(`Summary: ${summary ?? '[omitted; Claude did not return usable prose]'}`)

  if (arguments_.dryRun) {
    output.log('DRY RUN — no files, commits, tags, pushes, or GitHub releases will be created.')
    printCandidate(output, 'CHANGELOG.md', changelog.content)
    printCandidate(output, 'README.md', readme)
    printCandidate(output, 'package.json', manifestContent)
    output.log(`Would commit CHANGELOG.md, README.md, and package.json as "chore: release ${tag}".`)
    output.log(`Would create annotated tag ${tag} and atomically push HEAD plus ${tag} to origin.`)
    output.log(
      `Would publish GitHub Release ${tag} with the exact cut changelog section as its notes.`,
    )
    return
  }

  const originalHead = (
    await git(run, root, ['rev-parse', 'HEAD'], 'could not resolve the pre-release HEAD')
  ).stdout.trim()
  let pushed = false
  try {
    await Promise.all([
      writeFile(resolve(root, 'CHANGELOG.md'), changelog.content),
      writeFile(resolve(root, 'README.md'), readme),
      writeFile(resolve(root, 'package.json'), manifestContent),
    ])
    await git(run, root, ['diff', '--check'], 'release candidates failed git diff --check')
    await git(
      run,
      root,
      ['add', '--', 'CHANGELOG.md', 'README.md', 'package.json'],
      'could not stage release files',
    )
    const staged = await git(
      run,
      root,
      ['diff', '--cached', '--name-only'],
      'could not inspect staged release files',
    )
    const stagedPaths = staged.stdout.trim().split(/\r?\n/).sort()
    const expectedPaths = ['CHANGELOG.md', 'README.md', 'package.json'].sort()
    if (JSON.stringify(stagedPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error(
        `release commit must contain exactly ${expectedPaths.join(', ')}; found ${stagedPaths.join(', ')}`,
      )
    }
    await git(
      run,
      root,
      ['commit', '-m', `chore: release ${tag}`, '--', ...expectedPaths],
      `could not create release commit ${tag}`,
    )
    await git(
      run,
      root,
      ['tag', '-a', tag, '-m', `Release ${tag}`],
      `could not create annotated tag ${tag}`,
    )
    await git(
      run,
      root,
      [
        'push',
        '--atomic',
        'origin',
        `HEAD:refs/heads/${config.baseBranch}`,
        `refs/tags/${tag}:refs/tags/${tag}`,
      ],
      `could not atomically push ${config.baseBranch} and ${tag}`,
    )
    pushed = true
  } catch (error) {
    if (!pushed) await restoreBeforePush(run, root, originalHead, tag)
    throw error
  }

  const release = await run({
    command: 'gh',
    args: ['release', 'create', tag, '--verify-tag', '--title', tag, '--notes-file', '-'],
    cwd: root,
    stdin: changelog.cutSection,
  })
  if (release.exitCode !== 0) {
    const detail =
      release.stderr.trim() || release.stdout.trim() || `exit status ${release.exitCode}`
    const recoveryCommand = githubReleaseRecoveryCommand(tag, changelog.cutSection)
    throw new Error(
      `${config.baseBranch} and ${tag} were pushed, but GitHub Release publication failed: ${detail}.\n` +
        `Do not rewrite or delete the public refs. Run this verbatim retry command; it includes the exact cut-section notes:\n\n${recoveryCommand}`,
    )
  }

  await ensureClean(run, root)
  output.log(`Released ${tag}: commit and annotated tag pushed; GitHub Release published.`)
}

const usage =
  'Usage: bun run release (--version <semver> | --major | --minor | --patch) [--dry-run]'

if (import.meta.main) {
  try {
    await runRelease(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage)
    process.exitCode = 1
  }
}
