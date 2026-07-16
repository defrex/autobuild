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

/** Constant sha, or derived from the assigned PR number. */
export type HeadSha = string | ((number: number) => string)

export class FakeForge implements Forge {
  readonly name = 'fake'

  /** Journals — public so tests assert directly on call order and args. */
  readonly pushes: PushRecord[] = []
  readonly opened: OpenPrRecord[] = []
  readonly comments: CommentRecord[] = []

  private nextNumber = 1
  private headSha: HeadSha
  private readonly prs = new Map<number, PrState>()

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
    const headSha =
      typeof this.headSha === 'string' ? this.headSha : this.headSha(number)
    return { number, url: `https://fake.forge/pr/${number}`, headSha }
  }

  async getPrState(_workspacePath: string, number: number): Promise<PrState> {
    const state = this.prs.get(number)
    if (!state) throw new Error(`FakeForge: unknown PR #${number}`)
    return state
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
