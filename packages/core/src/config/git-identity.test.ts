import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from './load'

/**
 * Deterministic no-identity repro for the finalize-commit failure
 * (obs_cebe11ed / o_62444329): the changelog finalize step staged a correct
 * entry but `git commit` failed with 'Committer identity unknown' because the
 * guest workspace had no git identity. Two layers fix it and must carry the
 * identical bot identity:
 *
 * 1. a `git-identity` provisioning step in the repo-root `autobuild.toml`
 *    writing the identity to the guest's system git config, and
 * 2. a defensive both-keys fallback in the `ab-finalize-changelog` skill
 *    writing it repo-locally when resolution is missing or partial.
 *
 * The child environments below are constructed from scratch — never inherited
 * — because git's real identity overrides are GIT_AUTHOR_NAME,
 * GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL, EMAIL, and
 * GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n; any inherited variable
 * could leak host identity into a must-fail assertion.
 */

const REPO_ROOT = join(import.meta.dir, '../../../..')
const TOML_PATH = join(REPO_ROOT, 'autobuild.toml')
const SKILL_PATH = join(REPO_ROOT, '.agents/skills/ab-finalize-changelog/SKILL.md')
const PROVISIONING_COMMAND_IDENTITY =
  /git config --system user\.name '([^']+)' && git config --system user\.email '([^']+)'/

/** Provisioning step name and the bot identity both layers must agree on. */
async function provisionedIdentity(): Promise<{ name: string; email: string }> {
  const config = parseConfig(await Bun.file(TOML_PATH).text(), TOML_PATH)
  const vercel = config.workspace.config as {
    provisioning?: { name: string; command: string }[]
  }
  const step = vercel.provisioning?.find(({ name }) => name === 'git-identity')
  expect(step).toBeDefined()
  expect(step?.command).toContain('git config --system')
  const match =
    /git config --system user\.name '([^']+)' && git config --system user\.email '([^']+)'/.exec(
      step?.command ?? '',
    )
  expect(match).not.toBeNull()
  return { name: match?.[1] ?? '', email: match?.[2] ?? '' }
}

type ScratchEnv = Record<string, string>

/** Fresh env built from scratch: PATH, an empty HOME, and no git config sources. */
async function scratchEnv(): Promise<ScratchEnv> {
  const home = await mkdtemp(join(tmpdir(), 'git-identity-home-'))
  tempRoots.push(home)
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
}

function git(
  cwd: string,
  args: string[],
  env: ScratchEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  return Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }))
}

async function makeRepo(env: ScratchEnv): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'git-identity-repo-'))
  tempRoots.push(cwd)
  await git(cwd, ['init'], env)
  await writeFile(join(cwd, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n', 'utf8')
  await git(cwd, ['add', '--', 'CHANGELOG.md'], env)
  return cwd
}

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('git identity for finalize commits', () => {
  test('autobuild.toml provisions a git-identity step with a bot identity', async () => {
    const config = parseConfig(await Bun.file(TOML_PATH).text(), TOML_PATH)
    const vercel = config.workspace.config as {
      provisioning?: { name: string; command: string }[]
    }
    const step = vercel.provisioning?.at(-1)
    expect(step?.name).toBe('git-identity')
    expect(step?.command).toContain('git config --system')
    const match = PROVISIONING_COMMAND_IDENTITY.exec(step?.command ?? '')
    expect(match?.[1]).toBe('autobuild[bot]')
    expect(match?.[2]).toBe('autobuild[bot]@users.noreply.github.com')
  })

  test('the skill fallback uses the exact same identity as provisioning', async () => {
    const identity = await provisionedIdentity()
    const skill = await Bun.file(SKILL_PATH).text()
    expect(skill).toContain(`git config user.name '${identity.name}'`)
    expect(skill).toContain(`git config user.email '${identity.email}'`)
  })

  test('a from-scratch environment without identity fails git commit', async () => {
    const env = await scratchEnv()
    const cwd = await makeRepo(env)
    const commit = await git(cwd, ['commit', '-m', 'test', '--', 'CHANGELOG.md'], env)
    expect(commit.exitCode).not.toBe(0)
    expect(commit.stderr).toMatch(/please tell me who you are|identify/i)
  })

  test('the skill both-keys guard repairs an email-only partial identity', async () => {
    const env = await scratchEnv()
    const cwd = await makeRepo(env)
    await git(cwd, ['config', 'user.email', 'someone@example.com'], env)

    // The skill's guard: skip the fallback only when BOTH keys resolve.
    const name = await git(cwd, ['config', 'user.name'], env)
    const email = await git(cwd, ['config', 'user.email'], env)
    if (name.stdout.trim() === '' || email.stdout.trim() === '') {
      const identity = await provisionedIdentity()
      await git(cwd, ['config', 'user.name', identity.name], env)
      await git(cwd, ['config', 'user.email', identity.email], env)
    }

    const resolved = await git(cwd, ['config', 'user.name'], env)
    expect(resolved.stdout.trim()).toBe(await provisionedIdentity().then(({ name }) => name))
    const commit = await git(cwd, ['commit', '-m', 'test', '--', 'CHANGELOG.md'], env)
    expect(commit.exitCode).toBe(0)
  })

  test('the provisioned identity makes the commit succeed with a clean tree', async () => {
    const env = await scratchEnv()
    const cwd = await makeRepo(env)
    const identity = await provisionedIdentity()
    await git(cwd, ['config', 'user.name', identity.name], env)
    await git(cwd, ['config', 'user.email', identity.email], env)

    const commit = await git(cwd, ['commit', '-m', 'test', '--', 'CHANGELOG.md'], env)
    expect(commit.exitCode).toBe(0)

    const log = await git(cwd, ['log', '-1', '--format=%an|%ae|%cn|%ce'], env)
    expect(log.stdout.trim()).toBe(
      `${identity.name}|${identity.email}|${identity.name}|${identity.email}`,
    )
    const status = await git(cwd, ['status', '--porcelain'], env)
    expect(status.stdout).toBe('')
  })
})
