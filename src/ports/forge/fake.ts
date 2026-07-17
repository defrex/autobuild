/**
 * FakeForge (SPEC §3.2): in-memory Forge for seam tests. Every call is
 * journaled; PR lifecycle state is test-driven via `setPrState`, so janitor
 * scenarios (SPEC §15.7 — merged / closed / conflicted) run without a
 * network or a real forge.
 */
import type { Forge, PrRef, PrState } from '../types'

export interface PushRecord {
  workspacePath: string
  branch: string
}

export interface OpenPrRecord {
  workspacePath: string
  head: string
  base: string
  title: string
  body: string
}

export interface CommentRecord {
  workspacePath: string
  number: number
  body: string
}

export interface AutoMergeRecord {
  workspacePath: string
  number: number
  enabled: boolean
  /** False on an idempotent retry whose desired state was already applied. */
  changed: boolean
}

/** Constant sha, or derived from the assigned PR number. */
export type HeadSha = string | ((number: number) => string)

export class FakeForge implements Forge {
  readonly name = 'fake'

  /** Journals — public so tests assert directly on call order and args. */
  readonly pushes: PushRecord[] = []
  readonly opened: OpenPrRecord[] = []
  readonly comments: CommentRecord[] = []
  readonly autoMergeCalls: AutoMergeRecord[] = []

  private nextNumber = 1
  private headSha: HeadSha
  private readonly prs = new Map<number, PrState>()
  private readonly autoMerge = new Map<number, boolean>()

  constructor(opts: { headSha?: HeadSha } = {}) {
    this.headSha = opts.headSha ?? ((n) => `sha-${n}`)
  }

  /** Overrides the headSha for PRs opened after this call. */
  setHeadSha(headSha: HeadSha): void {
    this.headSha = headSha
  }

  /**
   * Drives `getPrState` for janitor scenarios. Registers `number` if it was
   * never opened through the fake, letting tests seed pre-existing PRs.
   */
  setPrState(number: number, state: PrState): void {
    this.prs.set(number, state)
    // Seeded/adopted PRs participate in auto-merge exactly like PRs opened by
    // the fake. Do not overwrite an explicitly seeded native state.
    if (!this.autoMerge.has(number)) this.autoMerge.set(number, false)
  }

  /** Seed native state without journaling a forge call. */
  setAutoMergeState(number: number, enabled: boolean): void {
    if (!this.prs.has(number)) {
      throw new Error(`FakeForge: unknown PR #${number}`)
    }
    this.autoMerge.set(number, enabled)
  }

  /** Inspect native state in seam/integration assertions. */
  isAutoMergeEnabled(number: number): boolean {
    if (!this.prs.has(number)) {
      throw new Error(`FakeForge: unknown PR #${number}`)
    }
    return this.autoMerge.get(number) ?? false
  }

  async pushBranch(workspacePath: string, branch: string): Promise<void> {
    this.pushes.push({ workspacePath, branch })
  }

  async openPr(opts: {
    workspacePath: string
    head: string
    base: string
    title: string
    body: string
  }): Promise<PrRef> {
    // Idempotent by head branch, mirroring GitHubForge (SPEC §8.7 crash
    // path): an existing OPEN PR for the same head is adopted, never
    // duplicated. `opened` journals only true creations, so its index keeps
    // mapping to the PR number.
    for (let i = this.opened.length - 1; i >= 0; i -= 1) {
      const number = i + 1
      if (this.opened[i]!.head !== opts.head) continue
      if (this.prs.get(number)?.state !== 'open') continue
      const headSha =
        typeof this.headSha === 'string' ? this.headSha : this.headSha(number)
      return { number, url: `https://fake.forge/pr/${number}`, headSha }
    }
    const number = this.nextNumber++
    this.opened.push({ ...opts })
    // A just-opened PR is open with mergeability not yet computed.
    this.prs.set(number, { state: 'open', mergeable: null })
    this.autoMerge.set(number, false)
    const headSha =
      typeof this.headSha === 'string' ? this.headSha : this.headSha(number)
    return { number, url: `https://fake.forge/pr/${number}`, headSha }
  }

  async getPrState(_workspacePath: string, number: number): Promise<PrState> {
    const state = this.prs.get(number)
    if (!state) throw new Error(`FakeForge: unknown PR #${number}`)
    return state
  }

  async setAutoMerge(
    workspacePath: string,
    number: number,
    enabled: boolean,
  ): Promise<void> {
    if (!this.prs.has(number)) {
      throw new Error(`FakeForge: unknown PR #${number}`)
    }
    const changed = (this.autoMerge.get(number) ?? false) !== enabled
    this.autoMerge.set(number, enabled)
    this.autoMergeCalls.push({ workspacePath, number, enabled, changed })
  }

  async commentOnPr(
    workspacePath: string,
    number: number,
    body: string,
  ): Promise<void> {
    if (!this.prs.has(number)) {
      throw new Error(`FakeForge: unknown PR #${number}`)
    }
    this.comments.push({ workspacePath, number, body })
  }
}
