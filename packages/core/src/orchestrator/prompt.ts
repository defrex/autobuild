/**
 * The turn's system prompt (AUT-342): the canonical `ab-operate` skill body,
 * plus the current `operator-notes` artifact, plus the session's wake
 * settings, plus the session's repository identity.
 *
 * The skill is read from the distribution's `skills/operate/SKILL.md` — the
 * same tree `ab init` vendors from — through `distributionPath`, and is
 * shipped into every hosted function that executes a turn (see
 * packages/hosted-dispatcher/src/ship-packed-distribution.ts). It is
 * self-contained per the vendored-skill rule and teaches the tool surface,
 * the attention set, and when to escalate rather than act; nothing
 * repository-specific may be inlined here.
 */
import { readFile } from 'node:fs/promises'
import { distributionPath } from '../distribution'
import { OPERATOR_NOTES_REPO_KIND } from '../store/retention'
import type { BuildStore } from '../store/types'
import type { OrchestratorConfig } from '../config/schema'

/** Where the canonical skill lives in the distribution tree. */
export const OPERATE_SKILL_PATH = 'skills/operate/SKILL.md'

/** Read the canonical skill body from the distribution tree. Throws when
 * the file is missing — a deployment that cannot load the canonical skill
 * must not run turns with a silently empty system prompt. */
export async function readOperateSkill(): Promise<string> {
  return readFile(distributionPath(...OPERATE_SKILL_PATH.split('/')), 'utf8')
}

export interface TurnPromptInput {
  store: BuildStore
  repo: string
  /** The session's wake globs (already resolved — empty means message-only). */
  wakeGlobs: readonly string[]
  config: OrchestratorConfig
}

/** Assemble the system prompt. The operator-notes artifact is empty when
 * absent; the skill body is always present (missing file throws). */
export async function buildTurnSystemPrompt(input: TurnPromptInput): Promise<string> {
  const skill = await readOperateSkill()
  const notes = await input.store.getRepoArtifact(input.repo, OPERATOR_NOTES_REPO_KIND)
  const notesText = notes === null ? '' : new TextDecoder().decode(notes.content).trim()
  return [
    skill,
    '',
    '## Repository',
    '',
    `You operate the repository ${JSON.stringify(input.repo)}. Every tool call is bound to this repository; you never supply a repo argument yourself.`,
    '',
    '## Operator notes',
    '',
    notesText === '' ? '(none recorded)' : notesText,
    '',
    '## Wake settings',
    '',
    input.wakeGlobs.length === 0
      ? 'This session wakes only on operator messages (no attention-event wake sources).'
      : `This session wakes on these attention-event globs: ${input.wakeGlobs.map((glob) => JSON.stringify(glob)).join(', ')}.`,
  ].join('\n')
}
