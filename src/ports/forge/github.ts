/**
 * GitHubForge (SPEC §3.2): the Forge adapter for GitHub, shelling out to
 * `git` and `gh` through an injectable exec seam. All remote access is
 * kernel-side plumbing (SPEC §8.6 [D7]) — agents never touch the remote,
 * so forge credentials never enter the sandbox.
 *
 * Body delivery: the exec seam is argv + cwd only (no stdin channel), so PR
 * and comment bodies are written to a temp file and passed with
 * `--body-file <path>` — a file survives arbitrary quoting and newlines in
 * the body. The temp-file writer is itself a seam so tests assert exact
 * argv arrays and the delivered content.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Forge, PrRef, PrState } from '../types'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Same seam shape as the workspace module: argv array, cwd, no shell. */
export type Exec = (
  cmd: string[],
  opts: { cwd: string },
) => Promise<ExecResult>

export const bunExec: Exec = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

/** Writes `content` somewhere on disk and returns the path. */
export type TempFileWriter = (content: string) => Promise<string>

export const defaultTempFileWriter: TempFileWriter = async (content) => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-forge-'))
  const path = join(dir, 'body.md')
  await writeFile(path, content, 'utf8')
  return path
}

// `gh --json` returns exactly the requested fields, so shapes are closed.
const prViewJson = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().min(1),
  headRefOid: z.string().min(1),
})

const prStateJson = z.strictObject({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeCommit: z.strictObject({ oid: z.string().min(1) }).nullable(),
})

// GitHub returns a nullable object whose inner fields are not needed here: the
// presence of the request is the native auto-merge state. Keeping the value
// `unknown` avoids coupling the port to GitHub's actor/merge-method projection.
const autoMergeJson = z.strictObject({
  autoMergeRequest: z.unknown().nullable(),
})

/** §15.7: mergeable false is what makes the janitor emit `pr.conflicted`. */
const MERGEABLE_MAP = {
  MERGEABLE: true,
  CONFLICTING: false,
  UNKNOWN: null,
} as const

export class GitHubForge implements Forge {
  readonly name = 'github'

  private readonly exec: Exec
  private readonly writeTempFile: TempFileWriter

  constructor(opts: { exec?: Exec; writeTempFile?: TempFileWriter } = {}) {
    this.exec = opts.exec ?? bunExec
    this.writeTempFile = opts.writeTempFile ?? defaultTempFileWriter
  }

  private async run(cmd: string[], cwd: string): Promise<string> {
    const result = await this.exec(cmd, { cwd })
    if (result.exitCode !== 0) {
      throw new Error(
        `forge command failed (exit ${result.exitCode}): ${cmd.join(' ')}\n` +
          result.stderr.trim(),
      )
    }
    return result.stdout
  }

  private parseJson<S extends z.ZodType>(
    schema: S,
    stdout: string,
    cmd: string[],
  ): z.infer<S> {
    try {
      return schema.parse(JSON.parse(stdout))
    } catch (error) {
      throw new Error(
        `unexpected output from \`${cmd.join(' ')}\`: ${String(error)}`,
      )
    }
  }

  /** [D1]: rebase is banned and branches are never rewritten — never force. */
  async pushBranch(workspacePath: string, branch: string): Promise<void> {
    await this.run(['git', 'push', '-u', 'origin', branch], workspacePath)
  }

  async openPr(opts: {
    workspacePath: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<PrRef> {
    // Idempotent by head branch (SPEC §8.7 crash paths): finalize's `ab done`
    // opens the PR BEFORE appending finalize.completed, so a crash or store
    // failure between the two makes the retry call openPr again. `gh pr
    // create` errors on an existing PR for the head branch; adopting the open
    // PR instead makes the re-run a harmless retry — the same rationale that
    // makes push-before-event safe for implement.
    const listCmd = [
      'gh',
      'pr',
      'list',
      '--head',
      opts.head,
      '--state',
      'open',
      '--json',
      'number,url,headRefOid',
    ]
    const listed = this.parseJson(
      z.array(prViewJson),
      await this.run(listCmd, opts.workspacePath),
      listCmd,
    )
    const existing = listed[0]
    if (existing !== undefined) {
      return {
        number: existing.number,
        url: existing.url,
        headSha: existing.headRefOid,
      }
    }
    const bodyPath = await this.writeTempFile(opts.body)
    await this.run(
      [
        'gh',
        'pr',
        'create',
        '--head',
        opts.head,
        '--base',
        opts.base,
        '--title',
        opts.title,
        '--body-file',
        bodyPath,
      ],
      opts.workspacePath,
    )
    // The number is unknown until the PR exists, so the follow-up view
    // selects by head branch — gh resolves an open PR from its head ref.
    const viewCmd = [
      'gh',
      'pr',
      'view',
      opts.head,
      '--json',
      'number,url,headRefOid',
    ]
    const stdout = await this.run(viewCmd, opts.workspacePath)
    const view = this.parseJson(prViewJson, stdout, viewCmd)
    return { number: view.number, url: view.url, headSha: view.headRefOid }
  }

  /** Janitor poll (SPEC §15.7): merged / closed / mergeability for one PR. */
  async getPrState(workspacePath: string, number: number): Promise<PrState> {
    const cmd = [
      'gh',
      'pr',
      'view',
      String(number),
      '--json',
      'state,mergeable,mergeCommit',
    ]
    const stdout = await this.run(cmd, workspacePath)
    const view = this.parseJson(prStateJson, stdout, cmd)
    switch (view.state) {
      case 'MERGED': {
        // §15.7 [D1]: pr.merged records the squash commit as the landing
        // point — a merged PR without one is unusable, not mappable.
        if (!view.mergeCommit) {
          throw new Error(`gh reports PR #${number} merged with no mergeCommit`)
        }
        return { state: 'merged', sha: view.mergeCommit.oid }
      }
      case 'CLOSED':
        return { state: 'closed' }
      case 'OPEN':
        return { state: 'open', mergeable: MERGEABLE_MAP[view.mergeable] }
    }
  }

  /**
   * Native auto-merge setter. Inspect first so retries are harmless: the forge
   * call may have succeeded before its correlated application event landed.
   * `--auto --squash` preserves required-check gating and the repository's D1
   * merge standard; there is deliberately no `--admin` fallback.
   */
  async setAutoMerge(
    workspacePath: string,
    number: number,
    enabled: boolean,
  ): Promise<void> {
    const viewCmd = [
      'gh',
      'pr',
      'view',
      String(number),
      '--json',
      'autoMergeRequest',
    ]
    const view = this.parseJson(
      autoMergeJson,
      await this.run(viewCmd, workspacePath),
      viewCmd,
    )
    const currentlyEnabled = view.autoMergeRequest !== null
    if (currentlyEnabled === enabled) return

    await this.run(
      enabled
        ? ['gh', 'pr', 'merge', String(number), '--auto', '--squash']
        : ['gh', 'pr', 'merge', String(number), '--disable-auto'],
      workspacePath,
    )
  }

  /** The build's summary comment (SPEC §7.5) — links into the store. */
  async commentOnPr(
    workspacePath: string,
    number: number,
    body: string,
  ): Promise<void> {
    const bodyPath = await this.writeTempFile(body)
    await this.run(
      ['gh', 'pr', 'comment', String(number), '--body-file', bodyPath],
      workspacePath,
    )
  }
}
