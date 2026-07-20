/**
 * The phase table (SPEC §4): a phase's name derives its skill, its events,
 * and its artifact kind — mechanically. This table also encodes each phase's
 * terminal discipline (D5), required deposits, context inputs (§8.3), and
 * plumbing (D7), so the CLI, the context builder, and the engine all validate
 * against the same data.
 */
import {
  isVerifyPhase,
  type CorePhase,
  type Phase,
} from '../ontology'
import type { EventType } from '../events/payloads'
import { installedSkillName } from '../skills'

export type PhaseKind = 'producer' | 'review' | 'agent-verify'
export type TerminalCommand = 'done' | 'verdict' | 'escalate'

/**
 * Kernel-side plumbing triggered by the phase's terminal (D7, §8.6):
 * agents only ever commit locally; push/PR happen at the boundary.
 */
export type PhasePlumbing = 'push-branch' | 'open-pr' | 'push-merge-commit'

/**
 * What `ab context` materializes for the phase (§8.3). Scoping is
 * deliberate: what a phase *can't* see is part of its design.
 */
export interface ContextInputs {
  ticket?: boolean
  spec?: boolean
  plan?: 'latest' | 'approved'
  /**
   * `current`: this round's feedback only (producers).
   * `all-rounds`: every prior round's findings, for `persists` marking
   * (reviewers — §15.4).
   */
  findings?: 'current' | 'all-rounds'
  /** Producer's own prior-round artifacts (plan revs / implement notes). */
  priorOwnArtifacts?: boolean
  commitRange?: boolean
  implementNotes?: boolean
  verifyReports?: boolean
  /** Reconcile: the fresh `{baseSha}` from this attempt's `reconcile.started` (§15.7). */
  conflict?: boolean
  prTemplate?: boolean
  /** Agent-verify: the step's config from autobuild.toml (§16.1). */
  stepConfig?: boolean
  /**
   * Answered guidance escalations addressed to THIS phase (§15.6-B, §11).
   * Finalize and reconcile have no producer round for the engine to feed the
   * answer into, so `ab context` is their delivery channel — the engine's
   * loop routing (loopOfPhase → 'other') relies on this input existing.
   */
  answeredGuidance?: boolean
}

export interface PhaseSpec {
  name: CorePhase | 'verify'
  kind: PhaseKind
  /** Installed, namespaced skill name. For verify steps the actual skill
   * comes from step config (§16.1). */
  skill: string
  startedEvent: EventType
  terminal: 'done' | 'verdict'
  terminalEvent: EventType
  /**
   * Artifact kind the terminal requires deposited (D5). For agent-verify
   * steps the report kind is per-step (`verify-report:<step>`) and required
   * only on `fail` — enforced by the CLI, not listed here.
   */
  requiredArtifact?: string
  /** Verdict vocabulary the CLI enforces (§8.2). */
  verdictVocabulary?: readonly string[]
  /** `implement` only: no `done` on a dirty worktree (D5). */
  requiresCleanWorktree?: boolean
  plumbing?: PhasePlumbing
  /** Whether `ab server` is allowed — implement and verify only (§8.2). */
  serverAccess: boolean
  inputs: ContextInputs
}

export const PHASE_SPECS: Record<CorePhase | 'verify', PhaseSpec> = {
  plan: {
    name: 'plan',
    kind: 'producer',
    skill: installedSkillName('plan'),
    startedEvent: 'plan.started',
    terminal: 'done',
    terminalEvent: 'plan.completed',
    requiredArtifact: 'plan',
    serverAccess: false,
    inputs: {
      ticket: true,
      spec: true,
      priorOwnArtifacts: true,
      findings: 'current',
    },
  },
  'plan-review': {
    name: 'plan-review',
    kind: 'review',
    skill: installedSkillName('plan-review'),
    startedEvent: 'plan-review.started',
    terminal: 'verdict',
    terminalEvent: 'plan-review.verdict',
    requiredArtifact: 'plan-review',
    verdictVocabulary: ['approve', 'revise', 'escalate'],
    serverAccess: false,
    inputs: { spec: true, plan: 'latest', findings: 'all-rounds' },
  },
  implement: {
    name: 'implement',
    kind: 'producer',
    skill: installedSkillName('implement'),
    startedEvent: 'implement.started',
    terminal: 'done',
    terminalEvent: 'implement.completed',
    requiredArtifact: 'implement-notes',
    requiresCleanWorktree: true,
    plumbing: 'push-branch',
    serverAccess: true,
    inputs: {
      spec: true,
      plan: 'approved',
      findings: 'current',
      verifyReports: true,
      priorOwnArtifacts: true,
    },
  },
  'code-review': {
    name: 'code-review',
    kind: 'review',
    skill: installedSkillName('code-review'),
    startedEvent: 'code-review.started',
    terminal: 'verdict',
    terminalEvent: 'code-review.verdict',
    requiredArtifact: 'code-review',
    verdictVocabulary: ['approve', 'revise', 'escalate'],
    serverAccess: false,
    inputs: {
      spec: true,
      plan: 'approved',
      commitRange: true,
      findings: 'all-rounds',
      implementNotes: true,
    },
  },
  verify: {
    name: 'verify',
    kind: 'agent-verify',
    skill: installedSkillName('verify'),
    startedEvent: 'verify.started',
    terminal: 'verdict',
    terminalEvent: 'verify.completed',
    verdictVocabulary: ['pass', 'fail', 'skip'],
    serverAccess: true,
    inputs: { spec: true, stepConfig: true, commitRange: true },
  },
  finalize: {
    name: 'finalize',
    kind: 'producer',
    skill: installedSkillName('finalize'),
    startedEvent: 'finalize.started',
    terminal: 'done',
    terminalEvent: 'finalize.completed',
    requiredArtifact: 'pr-description',
    plumbing: 'open-pr',
    serverAccess: false,
    inputs: {
      spec: true,
      plan: 'approved',
      verifyReports: true,
      prTemplate: true,
      answeredGuidance: true,
    },
  },
  reconcile: {
    name: 'reconcile',
    kind: 'producer',
    skill: installedSkillName('reconcile'),
    startedEvent: 'reconcile.started',
    terminal: 'done',
    terminalEvent: 'reconcile.completed',
    requiredArtifact: 'reconcile-notes',
    plumbing: 'push-merge-commit',
    serverAccess: false,
    inputs: {
      spec: true,
      plan: 'approved',
      implementNotes: true,
      conflict: true,
      answeredGuidance: true,
    },
  },
}

export function phaseSpecFor(phase: Phase): PhaseSpec {
  return isVerifyPhase(phase) ? PHASE_SPECS.verify : PHASE_SPECS[phase]
}

/** Every phase ends with exactly one terminal command (D5); `escalate` is
 * always available in addition to the phase's own terminal. */
export function allowedTerminals(phase: Phase): TerminalCommand[] {
  return [phaseSpecFor(phase).terminal, 'escalate']
}
