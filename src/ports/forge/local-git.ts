import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { AutoMergeResult, ClosePrResult, Forge, PrRef, PrState } from '../types'
import { bunExec, type Exec } from './github'

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const pendingLanding = z.strictObject({
  baseSha: objectId,
  headSha: objectId,
  treeSha: objectId,
  commitSha: objectId,
})
const localPrRecord = z.strictObject({
  version: z.literal(1),
  number: z.number().int().positive(),
  head: z.string().min(1),
  base: z.string().min(1),
  title: z.string(),
  body: z.string(),
  mergeMessage: z.string(),
  openedHeadSha: objectId,
  status: z.enum(['open', 'closed', 'merged']),
  mergedSha: objectId.optional(),
  pendingLanding: pendingLanding.optional(),
  comments: z.array(z.string()),
})
type LocalPrRecord = z.infer<typeof localPrRecord>

const PR_PREFIX = 'refs/autobuild/local-git/prs/'

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Offline Forge backed only by refs and objects in one repository's shared
 * Git database. No method invokes a shell, remote command, network client, or
 * `gh`; every subprocess is an argv-form `git` command. */
export class LocalGitForge implements Forge {
  readonly name = 'local-git'
  private readonly exec: Exec

  constructor(opts: { exec?: Exec } = {}) {
    this.exec = opts.exec ?? bunExec
  }

  private async command(args: string[], cwd: string, allowFailure = false) {
    const result = await this.exec(['git', ...args], { cwd })
    if (!allowFailure && result.exitCode !== 0) {
      throw new Error(
        `local-git command failed (exit ${result.exitCode}): git ${args.join(' ')}\n` +
          `${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
      )
    }
    return result
  }

  private async sha(ref: string, cwd: string): Promise<string> {
    const result = await this.command(['rev-parse', '--verify', `${ref}^{commit}`], cwd)
    const sha = result.stdout.trim()
    if (!objectId.safeParse(sha).success) {
      throw new Error(
        `local-git expected ${ref} to resolve to one commit, found ${JSON.stringify(sha)}`,
      )
    }
    return sha
  }

  private async assertRef(ref: string, cwd: string): Promise<void> {
    const result = await this.command(['check-ref-format', ref], cwd, true)
    if (result.exitCode !== 0)
      throw new Error(`local-git rejected invalid ref ${JSON.stringify(ref)}`)
  }

  private recordRef(number: number): string {
    return `${PR_PREFIX}${number}`
  }

  private async readRecord(
    cwd: string,
    number: number,
  ): Promise<{ record: LocalPrRecord; blob: string }> {
    const ref = this.recordRef(number)
    const resolved = await this.command(['rev-parse', '--verify', ref], cwd, true)
    if (resolved.exitCode !== 0) throw new Error(`local-git: unknown PR #${number}`)
    const blob = resolved.stdout.trim()
    if (!objectId.safeParse(blob).success) {
      throw new Error(
        `local-git PR #${number} ref contains malformed object id ${JSON.stringify(blob)}`,
      )
    }
    const source = await this.command(['cat-file', 'blob', blob], cwd)
    let value: unknown
    try {
      value = JSON.parse(source.stdout)
    } catch (error) {
      throw new Error(`local-git PR #${number} record is not JSON: ${detail(error)}`)
    }
    const parsed = localPrRecord.safeParse(value)
    if (!parsed.success || parsed.data.number !== number) {
      throw new Error(
        `local-git PR #${number} record is invalid: ` +
          (parsed.success ? `record names PR #${parsed.data.number}` : parsed.error.message),
      )
    }
    return { record: parsed.data, blob }
  }

  private async writeBlob(cwd: string, record: LocalPrRecord): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ab-local-git-'))
    try {
      const path = join(dir, 'record.json')
      await writeFile(path, `${JSON.stringify(record)}\n`, 'utf8')
      const result = await this.command(['hash-object', '-w', path], cwd)
      const sha = result.stdout.trim()
      if (!objectId.safeParse(sha).success)
        throw new Error('local-git failed to write PR record blob')
      return sha
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async objectZeros(cwd: string): Promise<string> {
    const result = await this.command(['rev-parse', '--show-object-format'], cwd)
    return result.stdout.trim() === 'sha256' ? '0'.repeat(64) : '0'.repeat(40)
  }

  private async createRecord(cwd: string, record: LocalPrRecord): Promise<boolean> {
    const blob = await this.writeBlob(cwd, record)
    const result = await this.command(
      ['update-ref', this.recordRef(record.number), blob, await this.objectZeros(cwd)],
      cwd,
      true,
    )
    return result.exitCode === 0
  }

  private async updateRecord(
    cwd: string,
    number: number,
    mutate: (record: LocalPrRecord) => LocalPrRecord,
  ): Promise<LocalPrRecord> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.readRecord(cwd, number)
      const next = localPrRecord.parse(mutate(current.record))
      const blob = await this.writeBlob(cwd, next)
      const result = await this.command(
        ['update-ref', this.recordRef(number), blob, current.blob],
        cwd,
        true,
      )
      if (result.exitCode === 0) return next
    }
    throw new Error(`local-git PR #${number} record changed concurrently too many times`)
  }

  private async records(cwd: string): Promise<LocalPrRecord[]> {
    const listed = await this.command(['for-each-ref', '--format=%(refname)', PR_PREFIX], cwd)
    const records: LocalPrRecord[] = []
    for (const ref of listed.stdout.split('\n').filter(Boolean)) {
      const suffix = ref.slice(PR_PREFIX.length)
      if (!/^[1-9][0-9]*$/.test(suffix)) {
        throw new Error(`local-git found malformed private PR ref ${JSON.stringify(ref)}`)
      }
      records.push((await this.readRecord(cwd, Number(suffix))).record)
    }
    return records.sort((a, b) => a.number - b.number)
  }

  async pushBranch(workspacePath: string, branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`
    await this.assertRef(ref, workspacePath)
    const symbolic = await this.command(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      workspacePath,
    )
    if (symbolic.stdout.trim() !== branch) {
      throw new Error(
        `local-git push requires workspace HEAD on ${JSON.stringify(branch)}, found ${JSON.stringify(symbolic.stdout.trim())}`,
      )
    }
    const [head, published] = await Promise.all([
      this.sha('HEAD', workspacePath),
      this.sha(ref, workspacePath),
    ])
    if (head !== published) {
      throw new Error(`local-git branch ${ref} does not resolve to workspace HEAD ${head}`)
    }
  }

  async snapshotBase(opts: {
    workspacePath: string
    base: string
    destinationRef: string
  }): Promise<string> {
    const source = `refs/heads/${opts.base}`
    await this.assertRef(source, opts.workspacePath)
    if (!opts.destinationRef.startsWith('refs/autobuild/')) {
      throw new Error('local-git base snapshot destination must be a private refs/autobuild ref')
    }
    await this.assertRef(opts.destinationRef, opts.workspacePath)
    const sha = await this.sha(source, opts.workspacePath)
    await this.command(['update-ref', opts.destinationRef, sha], opts.workspacePath)
    return sha
  }

  async openPr(opts: {
    workspacePath: string
    head: string
    base: string
    title: string
    body: string
    mergeMessage?: string
  }): Promise<PrRef> {
    const headRef = `refs/heads/${opts.head}`
    const baseRef = `refs/heads/${opts.base}`
    await this.assertRef(headRef, opts.workspacePath)
    await this.assertRef(baseRef, opts.workspacePath)
    const headSha = await this.sha(headRef, opts.workspacePath)
    await this.sha(baseRef, opts.workspacePath)

    for (;;) {
      const records = await this.records(opts.workspacePath)
      const adopted = records.find(
        (record) => record.status === 'open' && record.head === opts.head,
      )
      if (adopted !== undefined) {
        return { number: adopted.number, url: headRef, headSha }
      }
      const number = (records.at(-1)?.number ?? 0) + 1
      const created: LocalPrRecord = {
        version: 1,
        number,
        head: opts.head,
        base: opts.base,
        title: opts.title,
        body: opts.body,
        mergeMessage: opts.mergeMessage ?? [opts.title, opts.body].filter(Boolean).join('\n\n'),
        openedHeadSha: headSha,
        status: 'open',
        comments: [],
      }
      if (await this.createRecord(opts.workspacePath, created)) {
        return { number, url: headRef, headSha }
      }
      // Another process allocated this number. Re-scan so an equivalent
      // creation is adopted before considering the next number.
    }
  }

  private async mergeTree(cwd: string, baseSha: string, headSha: string): Promise<string | null> {
    const result = await this.command(['merge-tree', '--write-tree', baseSha, headSha], cwd, true)
    if (result.exitCode === 1) return null
    if (result.exitCode !== 0) {
      throw new Error(
        `local-git mergeability check failed (exit ${result.exitCode}): ` +
          `${result.stderr.trim() || result.stdout.trim() || '(no output)'}`,
      )
    }
    const tree = result.stdout.split('\n', 1)[0]!.trim()
    if (!objectId.safeParse(tree).success) {
      throw new Error(`local-git merge-tree returned malformed tree ${JSON.stringify(tree)}`)
    }
    return tree
  }

  private async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.command(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      cwd,
      true,
    )
    if (result.exitCode === 0) return true
    if (result.exitCode === 1) return false
    throw new Error(`local-git could not compare landing ancestry: ${result.stderr.trim()}`)
  }

  /** Apply Git's two-tree fast-forward operation. It carries index/worktree
   * changes on paths unchanged by the landing and refuses any tracked or
   * untracked overwrite. `dryRun` exercises those exact checks without writing. */
  private async transitionCheckout(
    checkout: string,
    from: string,
    to: string,
    dryRun: boolean,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const result = await this.command(
      ['read-tree', '-m', '-u', ...(dryRun ? ['-n'] : []), `${from}^{tree}`, `${to}^{tree}`],
      checkout,
      true,
    )
    if (result.exitCode === 0) return { ok: true }
    return {
      ok: false,
      detail:
        result.stderr.trim() ||
        result.stdout.trim() ||
        `git read-tree refused the checkout transition (exit ${result.exitCode})`,
    }
  }

  /** Repair the crash window after the base ref moved but before its checked-out
   * index/worktree was updated. A collision remains retryable and untouched. */
  private async repairObservedCheckout(
    cwd: string,
    baseRef: string,
    pending: z.infer<typeof pendingLanding>,
  ): Promise<boolean> {
    const checkout = await this.checkedOutBase(cwd, baseRef)
    if (checkout === undefined) return true
    return (await this.transitionCheckout(checkout, pending.baseSha, pending.commitSha, false)).ok
  }

  async getPrState(workspacePath: string, number: number): Promise<PrState> {
    let { record } = await this.readRecord(workspacePath, number)
    if (record.status === 'merged') return { state: 'merged', sha: record.mergedSha! }
    if (record.status === 'closed') return { state: 'closed' }

    const baseRef = `refs/heads/${record.base}`
    const baseSha = await this.sha(baseRef, workspacePath)
    if (
      record.pendingLanding !== undefined &&
      (await this.isAncestor(workspacePath, record.pendingLanding.commitSha, baseSha))
    ) {
      const landingSha = record.pendingLanding.commitSha
      // At the exact ref-move crash boundary, merged observation waits until
      // the checkout transition succeeds. A later descendant means another Git
      // operation already advanced the landed base, so there is no old checkout
      // left for this pending transition to repair.
      if (
        baseSha === landingSha &&
        !(await this.repairObservedCheckout(workspacePath, baseRef, record.pendingLanding))
      ) {
        return { state: 'open', mergeable: true }
      }
      record = await this.updateRecord(workspacePath, number, (current) => ({
        ...current,
        status: 'merged',
        mergedSha: landingSha,
        pendingLanding: undefined,
      }))
      return { state: 'merged', sha: record.mergedSha! }
    }

    const headRef = `refs/heads/${record.head}`
    const head = await this.command(
      ['rev-parse', '--verify', `${headRef}^{commit}`],
      workspacePath,
      true,
    )
    if (head.exitCode !== 0) {
      await this.updateRecord(workspacePath, number, (current) => ({
        ...current,
        status: 'closed',
      }))
      return { state: 'closed' }
    }
    const headSha = head.stdout.trim()
    if (!objectId.safeParse(headSha).success) {
      throw new Error(`local-git PR #${number} head ref is malformed`)
    }
    return {
      state: 'open',
      mergeable: (await this.mergeTree(workspacePath, baseSha, headSha)) !== null,
    }
  }

  async closePr(workspacePath: string, number: number): Promise<ClosePrResult> {
    const current = await this.getPrState(workspacePath, number)
    if (current.state === 'merged') return current
    if (current.state === 'closed') return current
    const record = await this.updateRecord(workspacePath, number, (value) =>
      value.status === 'merged' ? value : { ...value, status: 'closed', pendingLanding: undefined },
    )
    return record.status === 'merged'
      ? { state: 'merged', sha: record.mergedSha! }
      : { state: 'closed' }
  }

  async deleteBranch(workspacePath: string, branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`
    await this.assertRef(ref, workspacePath)
    await this.command(['update-ref', '-d', ref], workspacePath)
  }

  async setAutoMerge(
    workspacePath: string,
    number: number,
    enabled: boolean,
  ): Promise<AutoMergeResult> {
    const { record } = await this.readRecord(workspacePath, number)
    if (!enabled) return { kind: 'applied' }
    if (record.status !== 'open') return { kind: 'deferred' }
    const headSha = await this.sha(`refs/heads/${record.head}`, workspacePath)
    const baseRef = `refs/heads/${record.base}`
    const baseSha = await this.sha(baseRef, workspacePath)

    let transitionFrom = baseSha
    let transitionTo: string
    const pending = record.pendingLanding
    if (
      pending !== undefined &&
      pending.headSha === headSha &&
      (baseSha === pending.baseSha || baseSha === pending.commitSha)
    ) {
      // This includes the post-ref checkout-repair window. Always inspect the
      // recorded old-to-landed transition; current-base-to-head is a no-op there
      // and would conceal the operator path that still blocks repair.
      transitionFrom = pending.baseSha
      transitionTo = pending.commitSha
    } else {
      const treeSha = await this.mergeTree(workspacePath, baseSha, headSha)
      if (treeSha === null) return { kind: 'deferred' }
      transitionTo = treeSha
    }

    const checkout = await this.checkedOutBase(workspacePath, baseRef)
    if (checkout !== undefined) {
      const preflight = await this.transitionCheckout(checkout, transitionFrom, transitionTo, true)
      if (!preflight.ok) {
        return {
          kind: 'deferred',
          reason: { code: 'local-base-checkout-dirty', detail: preflight.detail },
        }
      }
    }
    return { kind: 'ungated', headSha }
  }

  private async checkedOutBase(cwd: string, baseRef: string): Promise<string | undefined> {
    const result = await this.command(['worktree', 'list', '--porcelain'], cwd)
    let path: string | undefined
    for (const line of `${result.stdout}\n`.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      if (line === `branch ${baseRef}`) return path
      if (line === '') path = undefined
    }
    return undefined
  }

  private async commitTree(
    cwd: string,
    treeSha: string,
    baseSha: string,
    message: string,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ab-local-git-commit-'))
    try {
      const path = join(dir, 'message.md')
      await writeFile(path, message, 'utf8')
      const result = await this.command(
        [
          '-c',
          'commit.gpgSign=false',
          '-c',
          'user.name=Autobuild',
          '-c',
          'user.email=autobuild@localhost',
          'commit-tree',
          treeSha,
          '-p',
          baseSha,
          '-F',
          path,
        ],
        cwd,
      )
      const sha = result.stdout.trim()
      if (!objectId.safeParse(sha).success)
        throw new Error('local-git commit-tree returned no commit')
      return sha
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async squashMerge(workspacePath: string, number: number, expectedHeadSha: string): Promise<void> {
    let { record } = await this.readRecord(workspacePath, number)
    if (record.status === 'merged') return
    const headRef = `refs/heads/${record.head}`
    const baseRef = `refs/heads/${record.base}`
    const headSha = await this.sha(headRef, workspacePath)
    if (headSha !== expectedHeadSha) {
      throw new Error(
        `local-git PR #${number} head changed (expected ${expectedHeadSha}, found ${headSha})`,
      )
    }
    let baseSha = await this.sha(baseRef, workspacePath)

    if (record.pendingLanding !== undefined) {
      if (await this.isAncestor(workspacePath, record.pendingLanding.commitSha, baseSha)) return
      if (record.pendingLanding.baseSha === baseSha && record.pendingLanding.headSha === headSha) {
        // Resume the crash window after pending evidence but before ref update.
      } else {
        record = await this.updateRecord(workspacePath, number, (current) => ({
          ...current,
          pendingLanding: undefined,
        }))
      }
    }

    let pending = record.pendingLanding
    if (pending === undefined) {
      const treeSha = await this.mergeTree(workspacePath, baseSha, headSha)
      if (treeSha === null) throw new Error(`local-git PR #${number} is not mergeable`)
      const commitSha = await this.commitTree(workspacePath, treeSha, baseSha, record.mergeMessage)
      pending = { baseSha, headSha, treeSha, commitSha }
      record = await this.updateRecord(workspacePath, number, (current) => ({
        ...current,
        pendingLanding: pending,
      }))
    }

    baseSha = await this.sha(baseRef, workspacePath)
    if (baseSha !== pending.baseSha) {
      if (await this.isAncestor(workspacePath, pending.commitSha, baseSha)) return
      throw new Error(`local-git base ${baseRef} moved during guarded squash inspection`)
    }

    const checkout = await this.checkedOutBase(workspacePath, baseRef)
    if (checkout !== undefined) {
      // Close the inspection-to-landing race at the last safe point. A refusal
      // is a condition, not a failed dispatcher tick; pending evidence remains
      // reusable and the next poll reports the typed deferral.
      const preflight = await this.transitionCheckout(
        checkout,
        pending.baseSha,
        pending.commitSha,
        true,
      )
      if (!preflight.ok) return
    }
    const moved = await this.command(
      ['update-ref', baseRef, pending.commitSha, pending.baseSha],
      workspacePath,
      true,
    )
    if (moved.exitCode !== 0) {
      throw new Error(`local-git base ${baseRef} moved before squash landing`)
    }
    if (checkout !== undefined) {
      // A racing operator edit can still appear after preflight. Never roll the
      // ref back or overwrite it: leave the pending landing for getPrState and
      // setAutoMerge to repair/report on a later poll.
      await this.transitionCheckout(checkout, pending.baseSha, pending.commitSha, false)
    }
    // Deliberately do not mark the record merged here. The next getPrState
    // independently observes the landed commit and records that fact.
  }

  async commentOnPr(workspacePath: string, number: number, body: string): Promise<void> {
    await this.updateRecord(workspacePath, number, (record) => ({
      ...record,
      comments: record.comments.includes(body) ? record.comments : [...record.comments, body],
    }))
  }
}
