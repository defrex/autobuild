/**
 * FakeForge (SPEC §3.2): in-memory Forge for seam tests. Gate existence and
 * current PR merge state are independent inputs, matching GitHubForge's safety
 * model; every native/direct mutation is journaled.
 */
import {
  classifyAutoMergeEnable,
  type MergeGatePresence,
  type MergeStateStatus,
} from '../../kernel/auto-merge'
import type {
  AutoMergeResult,
  DashboardFrameHosting,
  DashboardFrameReclaimRequest,
  DashboardFrameUploadRequest,
  Forge,
  PrRef,
  PrState,
} from '../types'
import type { HostedDashboardFrameAsset } from '../../ontology'

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
  /** False on an idempotent retry or a result that leaves native state off. */
  changed: boolean
}

export interface SquashMergeRecord {
  workspacePath: string
  number: number
  expectedHeadSha: string
}

export type DashboardFrameUploadRecord = DashboardFrameUploadRequest
export type DashboardFrameReclaimRecord = DashboardFrameReclaimRequest

/** Constant sha, or derived from the assigned PR number. */
export type HeadSha = string | ((number: number) => string)
export type MergeSha = string | ((number: number) => string)

type FakeGateState = MergeGatePresence | { error: string }

export class FakeForge implements Forge {
  readonly name = 'fake'
  readonly dashboardFrames?: DashboardFrameHosting

  /** Journals — public so tests assert directly on call order and args. */
  readonly pushes: PushRecord[] = []
  readonly opened: OpenPrRecord[] = []
  readonly comments: CommentRecord[] = []
  readonly autoMergeCalls: AutoMergeRecord[] = []
  readonly squashMergeCalls: SquashMergeRecord[] = []
  readonly dashboardFrameUploads: DashboardFrameUploadRecord[] = []
  readonly dashboardFrameReclaims: DashboardFrameReclaimRecord[] = []

  private nextNumber = 1
  private nextDashboardAssetId = 1
  private headSha: HeadSha
  private mergeSha: MergeSha
  private readonly defaultGatePresence: MergeGatePresence
  private readonly prs = new Map<number, PrState>()
  private readonly headShas = new Map<number, string>()
  private readonly mergeStates = new Map<number, MergeStateStatus>()
  private readonly gates = new Map<number, FakeGateState>()
  private readonly autoMerge = new Map<number, boolean>()
  private readonly nativeErrors = new Map<number, string>()
  private readonly squashErrors = new Map<number, string>()
  private readonly dashboardAssets = new Map<string, HostedDashboardFrameAsset>()
  private readonly dashboardUploadErrors: string[] = []
  private readonly dashboardReclaimErrors: string[] = []

  constructor(
    opts: {
      headSha?: HeadSha
      mergeSha?: MergeSha
      gatePresence?: MergeGatePresence
      /** Hosting is unsupported by default, matching a forge without this
       * optional capability. Tests opt in explicitly. */
      dashboardFrames?: boolean
    } = {},
  ) {
    this.headSha = opts.headSha ?? ((n) => `sha-${n}`)
    this.mergeSha = opts.mergeSha ?? ((n) => `squash-${n}`)
    // Existing tests model the historical, gated native path unless they opt
    // into the ungated repository scenario explicitly.
    this.defaultGatePresence = opts.gatePresence ?? 'present'
    if (opts.dashboardFrames === true) {
      this.dashboardFrames = {
        upload: (request) => this.uploadDashboardFrame(request),
        reclaim: (request) => this.reclaimDashboardFrame(request),
      }
    }
  }

  private resolveHeadSha(number: number): string {
    return typeof this.headSha === 'string' ? this.headSha : this.headSha(number)
  }

  private resolveMergeSha(number: number): string {
    return typeof this.mergeSha === 'string' ? this.mergeSha : this.mergeSha(number)
  }

  private assertPr(number: number): void {
    if (!this.prs.has(number)) throw new Error(`FakeForge: unknown PR #${number}`)
  }

  private registerPr(number: number, state: PrState): void {
    this.prs.set(number, state)
    if (!this.headShas.has(number)) this.headShas.set(number, this.resolveHeadSha(number))
    if (!this.autoMerge.has(number)) this.autoMerge.set(number, false)
    if (!this.gates.has(number)) this.gates.set(number, this.defaultGatePresence)
    if (!this.mergeStates.has(number)) {
      const mergeState: MergeStateStatus =
        state.state !== 'open'
          ? 'UNKNOWN'
          : state.mergeable === true
            ? 'CLEAN'
            : state.mergeable === false
              ? 'DIRTY'
              : 'UNKNOWN'
      this.mergeStates.set(number, mergeState)
    }
  }

  /** Overrides the headSha for PRs opened after this call. */
  setHeadSha(headSha: HeadSha): void {
    this.headSha = headSha
  }

  /** Drives lifecycle/mergeability independently from gate presence. */
  setPrState(number: number, state: PrState): void {
    const known = this.prs.has(number)
    this.registerPr(number, state)
    if (known && state.state === 'open') {
      this.mergeStates.set(
        number,
        state.mergeable === true
          ? 'CLEAN'
          : state.mergeable === false
            ? 'DIRTY'
            : 'UNKNOWN',
      )
    }
  }

  /** Seed the exact GitHub mergeStateStatus without changing mergeability. */
  setMergeStateStatus(number: number, state: MergeStateStatus): void {
    this.assertPr(number)
    this.mergeStates.set(number, state)
  }

  /** Seed gate existence independently from current merge status/check health. */
  setGatePresence(number: number, presence: MergeGatePresence): void {
    this.assertPr(number)
    this.gates.set(number, presence)
  }

  /** Seed a fail-closed gate-probe/auth/schema error. */
  setGateProbeError(number: number, message: string): void {
    this.assertPr(number)
    this.gates.set(number, { error: message })
  }

  /** Simulate a native auto-merge mutation failure. */
  setNativeAutoMergeError(number: number, message: string): void {
    this.assertPr(number)
    this.nativeErrors.set(number, message)
  }

  /** Simulate a guarded direct-squash command failure. */
  setSquashMergeError(number: number, message: string): void {
    this.assertPr(number)
    this.squashErrors.set(number, message)
  }

  /** Fail the next opt-in hosting call; queues permit deterministic mid-set failures. */
  failNextDashboardFrameUpload(message: string): void {
    this.dashboardUploadErrors.push(message)
  }

  /** Fail the next cleanup call; the following retry resumes normal behavior. */
  failNextDashboardFrameReclaim(message: string): void {
    this.dashboardReclaimErrors.push(message)
  }

  private dashboardAssetKey(request: DashboardFrameUploadRequest): string {
    return [
      request.target.repository,
      request.target.releaseId,
      request.prUrl,
      request.name,
      request.sha256,
    ].join('\0')
  }

  private async uploadDashboardFrame(
    request: DashboardFrameUploadRequest,
  ): Promise<HostedDashboardFrameAsset> {
    this.dashboardFrameUploads.push({
      ...request,
      content: request.content.slice(),
    })
    const error = this.dashboardUploadErrors.shift()
    if (error !== undefined) throw new Error(error)
    const key = this.dashboardAssetKey(request)
    const existing = this.dashboardAssets.get(key)
    if (existing !== undefined) return existing
    const assetId = this.nextDashboardAssetId++
    const asset: HostedDashboardFrameAsset = {
      provider: 'github-release',
      repository: request.target.repository,
      releaseId: request.target.releaseId,
      assetId,
      url:
        `https://fake.forge/dashboard-frames/${assetId}/` +
        `${encodeURIComponent(request.name)}.png`,
    }
    this.dashboardAssets.set(key, asset)
    return asset
  }

  private async reclaimDashboardFrame(
    request: DashboardFrameReclaimRequest,
  ): Promise<void> {
    this.dashboardFrameReclaims.push({ ...request, asset: { ...request.asset } })
    const error = this.dashboardReclaimErrors.shift()
    if (error !== undefined) throw new Error(error)
    for (const [key, asset] of this.dashboardAssets) {
      if (asset.assetId === request.asset.assetId) this.dashboardAssets.delete(key)
    }
    // Missing means it was already deleted: cleanup is idempotent.
  }

  /** Move the PR head to exercise --match-head-commit race rejection. */
  setPrHeadSha(number: number, headSha: string): void {
    this.assertPr(number)
    this.headShas.set(number, headSha)
  }

  /** Seed native state without journaling a forge call. */
  setAutoMergeState(number: number, enabled: boolean): void {
    this.assertPr(number)
    this.autoMerge.set(number, enabled)
  }

  /** Inspect native state in seam/integration assertions. */
  isAutoMergeEnabled(number: number): boolean {
    this.assertPr(number)
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
    // Idempotent by head branch, mirroring GitHubForge (SPEC §8.7).
    for (let i = this.opened.length - 1; i >= 0; i -= 1) {
      const number = i + 1
      if (this.opened[i]!.head !== opts.head) continue
      if (this.prs.get(number)?.state !== 'open') continue
      return {
        number,
        url: `https://fake.forge/pr/${number}`,
        headSha: this.headShas.get(number)!,
      }
    }
    const number = this.nextNumber++
    this.opened.push({ ...opts })
    this.registerPr(number, { state: 'open', mergeable: null })
    return {
      number,
      url: `https://fake.forge/pr/${number}`,
      headSha: this.headShas.get(number)!,
    }
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
  ): Promise<AutoMergeResult> {
    this.assertPr(number)
    const currentlyEnabled = this.autoMerge.get(number) ?? false

    if (!enabled || currentlyEnabled) {
      const changed = currentlyEnabled !== enabled
      this.autoMerge.set(number, enabled)
      this.autoMergeCalls.push({ workspacePath, number, enabled, changed })
      return { kind: 'applied' }
    }

    const gate = this.gates.get(number) ?? this.defaultGatePresence
    if (typeof gate === 'object') throw new Error(gate.error)
    const mergeState = this.mergeStates.get(number) ?? 'UNKNOWN'
    const disposition = classifyAutoMergeEnable(mergeState, gate)
    switch (disposition.kind) {
      case 'native': {
        const error = this.nativeErrors.get(number)
        if (error !== undefined) throw new Error(error)
        this.autoMerge.set(number, true)
        this.autoMergeCalls.push({
          workspacePath,
          number,
          enabled: true,
          changed: true,
        })
        return { kind: 'applied' }
      }
      case 'direct':
        this.autoMergeCalls.push({
          workspacePath,
          number,
          enabled: true,
          changed: false,
        })
        return { kind: 'ungated', headSha: this.headShas.get(number)! }
      case 'deferred':
        this.autoMergeCalls.push({
          workspacePath,
          number,
          enabled: true,
          changed: false,
        })
        return { kind: 'deferred' }
      case 'error':
        throw new Error(disposition.reason)
    }
  }

  async squashMerge(
    workspacePath: string,
    number: number,
    expectedHeadSha: string,
  ): Promise<void> {
    this.assertPr(number)
    const error = this.squashErrors.get(number)
    if (error !== undefined) throw new Error(error)

    const state = this.prs.get(number)!
    if (state.state !== 'open' || state.mergeable !== true) {
      throw new Error(`FakeForge: PR #${number} is not positively mergeable`)
    }
    const actualHeadSha = this.headShas.get(number)!
    if (actualHeadSha !== expectedHeadSha) {
      throw new Error(
        `FakeForge: PR #${number} head changed (expected ${expectedHeadSha}, found ${actualHeadSha})`,
      )
    }
    const gate = this.gates.get(number) ?? this.defaultGatePresence
    if (typeof gate === 'object') throw new Error(gate.error)
    if (gate !== 'absent') {
      throw new Error(`FakeForge: PR #${number} is protected by a merge-blocking gate`)
    }
    const disposition = classifyAutoMergeEnable(
      this.mergeStates.get(number) ?? 'UNKNOWN',
      gate,
    )
    if (disposition.kind !== 'direct') {
      throw new Error(`FakeForge: PR #${number} is no longer direct-merge eligible`)
    }

    this.squashMergeCalls.push({ workspacePath, number, expectedHeadSha })
    this.prs.set(number, { state: 'merged', sha: this.resolveMergeSha(number) })
  }

  async commentOnPr(
    workspacePath: string,
    number: number,
    body: string,
  ): Promise<void> {
    this.assertPr(number)
    this.comments.push({ workspacePath, number, body })
  }
}
