/**
 * Test-support fixtures for the CLI suite — imported only by the colocated
 * `*.test.ts` files, never by production code (mirrors the src/testing rule).
 *
 * The store fixture is a seeded MemoryBuildStore (the reference adapter — its
 * behavior IS the contract, store/contract.ts) and the git fixtures are real
 * throwaway repos, matching the patterns in git-worktree.test.ts.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DISPATCHER } from '../events/envelope'
import { sequentialIds } from '../ids'
import { FakeForge } from '../ports/forge/fake'
import { spawnExec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import type { CliEnv } from './env'
import type { CliDeps } from './main'

export const BUILD = 'auth-rate-limit'
export const BRANCH = 'ab/auth-rate-limit'

export function makeEnv(overrides: Partial<CliEnv> = {}): CliEnv {
  return {
    store: '/tmp/ab-store',
    build: BUILD,
    phase: 'implement',
    round: 1,
    session: 's_test',
    ...overrides,
  }
}

/** Build + `build.created` + spec@0 (`spec.imported`) — every phase's floor. */
export async function seedStore(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.createBuild({ slug: BUILD, repo: 'acme/app', branch: BRANCH })
  await store.append(BUILD, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: {
        source: 'linear',
        id: 'ENG-42',
        url: 'https://linear.app/acme/issue/ENG-42',
        title: 'Auth rate limiting',
      },
      repo: 'acme/app',
      baseBranch: 'main',
    },
  })
  await store.putArtifact(BUILD, {
    kind: 'spec',
    content: '# Spec: auth rate limiting\n',
  })
  await store.append(BUILD, {
    actor: DISPATCHER,
    type: 'spec.imported',
    payload: {
      artifact: { kind: 'spec', rev: 0 },
      ticket: { source: 'linear', id: 'ENG-42' },
    },
  })
  return store
}

export interface TestDeps extends CliDeps {
  forge: FakeForge
  out: string[]
  err: string[]
}

export function makeDeps(opts: {
  store: MemoryBuildStore
  env: CliEnv
  workspacePath?: string
  forge?: FakeForge
}): TestDeps {
  const out: string[] = []
  const err: string[] = []
  const forge = opts.forge ?? new FakeForge()
  return {
    store: opts.store,
    env: opts.env,
    workspacePath: opts.workspacePath ?? '/nonexistent-workspace',
    forge,
    exec: spawnExec,
    ids: sequentialIds(),
    clock: steppingClock(),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    out,
    err,
  }
}

// ── Real-git fixtures (identity pinned per invocation, like git-worktree.test) ─

export const GIT_ID = [
  '-c',
  'user.email=ab@test.invalid',
  '-c',
  'user.name=ab-test',
  '-c',
  'commit.gpgsign=false',
]

export async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * A workspace repo on branch `ab/auth-rate-limit`, branched off `main`.
 * Deliberately does NOT gitignore `.ab/` — real repos don't either (§7:
 * establishing the gitignored scratch dir is the PRODUCT's job, via the
 * self-excluding `.ab/.gitignore` that `ab context` writes); a fixture that
 * hand-wrote the ignore would hide a regression in that mechanism.
 */
export async function initWorkspaceRepo(dir: string, branch = BRANCH): Promise<void> {
  await mkdir(dir, { recursive: true })
  await runGit(['init', '-q', '-b', 'main'], dir)
  await writeFile(join(dir, 'README.md'), 'fixture\n')
  await runGit(['add', '.'], dir)
  await runGit([...GIT_ID, 'commit', '-q', '-m', 'initial'], dir)
  await runGit(['checkout', '-q', '-b', branch], dir)
}

export async function commitFile(
  dir: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(dir, file), content)
  await runGit(['add', file], dir)
  await runGit([...GIT_ID, 'commit', '-q', '-m', message], dir)
  return runGit(['rev-parse', 'HEAD'], dir)
}
