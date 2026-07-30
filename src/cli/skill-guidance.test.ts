/**
 * Guidance-delivery content guards: the seam between the phase table and the
 * four skills that can receive a human's answer.
 *
 * `ab context` writes `.ab/guidance.json` from exactly two inputs — the
 * producer round-feedback union (`inputs.findings === 'current'`, whose third
 * member is `{guidance}`) and `inputs.answeredGuidance === true` (finalize and
 * reconcile, whose delivery channel IS `ab context`). The receiving set is
 * therefore DERIVED from `PHASE_SPECS` rather than listed here: grant
 * `answeredGuidance` to a fifth phase and this suite fails until that phase's
 * skill names the file, instead of shipping an agent that is never told where
 * the human's answer landed.
 *
 * The second guard mechanizes "no instruction points a phase at a file a
 * guidance round does not produce". Prose cannot be type-checked, so the unit
 * of an instruction is the blank-line-separated block — a paragraph, a bullet,
 * a numbered step — and a block naming `.ab/findings.json` must also name
 * `.ab/guidance.json`. Fenced code is deliberately NOT stripped: a sample
 * command that reads `.ab/findings.json` unconditionally is an instruction too.
 *
 * `.ab/verify/` is excluded from that rule on purpose. `implement` has
 * `verifyReports: true`, so its verify reports are materialized from every
 * deposit regardless of feedback and can be present on a guidance round. Only
 * `.ab/findings.json` is written solely as feedback, so only it is the file a
 * guidance round provably does not produce.
 *
 * If a guard feels awkward to satisfy, fix the prose, not the anchor:
 * loosening the rule restores the vacuous version it exists to prevent.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { PHASE_SPECS, type PhaseSpec } from '../kernel/phases'
import { readDistSkills } from './init'

const DIST_ROOT = resolve(import.meta.dir, '..', '..')

/** The two `ab context` inputs that materialize `.ab/guidance.json`. */
function receivesGuidance(spec: PhaseSpec): boolean {
  return spec.inputs.answeredGuidance === true || spec.inputs.findings === 'current'
}

const guidancePhases = Object.values(PHASE_SPECS).filter(receivesGuidance)
const skills = await readDistSkills(DIST_ROOT)
const byInstallName = new Map(skills.map((skill) => [skill.installName, skill]))

describe('guidance delivery — every receiving phase documents the file', () => {
  test('the derived receiving set is the four phases the contract covers', () => {
    expect(guidancePhases.map((spec) => spec.skill).sort()).toEqual([
      'ab-finalize',
      'ab-implement',
      'ab-plan',
      'ab-reconcile',
    ])
  })

  test('each receiving phase ships a skill naming `.ab/guidance.json`', () => {
    const missing: string[] = []
    for (const spec of guidancePhases) {
      const skill = byInstallName.get(spec.skill)
      if (skill === undefined) {
        missing.push(`${spec.skill} (no such skill in the distribution)`)
        continue
      }
      if (!skill.content.includes('.ab/guidance.json')) missing.push(spec.skill)
    }
    expect(
      missing,
      `phases that can receive human guidance without a skill naming .ab/guidance.json: ${missing.join(', ')}`,
    ).toEqual([])
  })

  test('no instruction points at `.ab/findings.json` without the guidance alternative', () => {
    const offenders: string[] = []
    for (const spec of guidancePhases) {
      if (spec.inputs.findings !== 'current') continue
      const skill = byInstallName.get(spec.skill)
      if (skill === undefined) continue
      for (const block of skill.content.split(/\n\s*\n/)) {
        if (!block.includes('.ab/findings.json')) continue
        if (block.includes('.ab/guidance.json')) continue
        offenders.push(`${spec.skill}:\n${block}`)
      }
    }
    expect(
      offenders,
      `instructions naming .ab/findings.json on a round that may carry guidance instead:\n${offenders.join('\n---\n')}`,
    ).toEqual([])
  })
})
