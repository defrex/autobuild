/**
 * Guidance-delivery content guards: the seam between the phase table and the
 * skills that can receive a human's answer.
 *
 * `ab context` writes `$AB_CONTEXT_DIR/guidance.json` from three inputs — the producer
 * round-feedback union (`inputs.findings === 'current'`, whose third member is
 * `{guidance}`), feedback cited by an agent verifier's exact started event
 * (`inputs.currentFeedback === true`), and `inputs.answeredGuidance === true`
 * (finalize and reconcile, whose delivery channel IS `ab context`). The
 * receiving set is therefore DERIVED from `PHASE_SPECS` rather than listed
 * here: grant a phase another guidance input and this suite fails until its
 * skill names the file, instead of shipping an agent that is never told where
 * the human's answer landed.
 *
 * The second guard mechanizes "no instruction points a phase at a file a
 * guidance round does not produce". Prose cannot be type-checked, so the unit
 * of an instruction is the blank-line-separated block — a paragraph, a bullet,
 * a numbered step — and a block naming `$AB_CONTEXT_DIR/findings.json` must also name
 * `$AB_CONTEXT_DIR/guidance.json`. Fenced code is deliberately NOT stripped: a sample
 * command that reads `$AB_CONTEXT_DIR/findings.json` unconditionally is an instruction too.
 *
 * `.ab/verify/` is excluded from that rule on purpose. `implement` has
 * `verifyReports: true`, so its verify reports are materialized from every
 * deposit regardless of feedback and can be present on a guidance round. Only
 * `$AB_CONTEXT_DIR/findings.json` is written solely as feedback, so only it is the file a
 * guidance round provably does not produce.
 *
 * If a guard feels awkward to satisfy, fix the prose, not the anchor:
 * loosening the rule restores the vacuous version it exists to prevent.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { PHASE_SPECS, type PhaseSpec } from '../kernel/phases'
import { readDistSkills } from './init'

const DIST_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

/** The `ab context` inputs that can materialize `$AB_CONTEXT_DIR/guidance.json`. */
function receivesGuidance(spec: PhaseSpec): boolean {
  return (
    spec.inputs.answeredGuidance === true ||
    spec.inputs.findings === 'current' ||
    spec.inputs.currentFeedback === true
  )
}

const guidancePhases = Object.values(PHASE_SPECS).filter(receivesGuidance)
const skills = await readDistSkills(DIST_ROOT)
const byInstallName = new Map(skills.map((skill) => [skill.installName, skill]))
const guide = byInstallName.get('ab-guide')
const setupReference = guide?.files.find((file) => file.path === 'references/setup.md')

/** Verify's skill is repository-selected. Its authoring contract lives in the
 * installed setup reference rather than in a generic shipped verifier. */
function guidanceDocumentsFor(spec: PhaseSpec): Array<{ name: string; content: string }> {
  if (spec.kind === 'agent-verify') {
    return setupReference === undefined
      ? []
      : [{ name: 'ab-guide/references/setup.md', content: setupReference.content }]
  }
  const skill = byInstallName.get(spec.skill)
  return skill === undefined ? [] : [{ name: spec.skill, content: skill.content }]
}

describe('guidance delivery — every receiving phase documents the file', () => {
  test('the derived receiving set is the six phase kinds the contract covers', () => {
    expect(guidancePhases.map((spec) => spec.name).sort()).toEqual([
      'finalize',
      'implement',
      'plan',
      'propose',
      'reconcile',
      'verify',
    ])
  })

  test('each receiving phase ships a skill naming `$AB_CONTEXT_DIR/guidance.json`', () => {
    const missing: string[] = []
    for (const spec of guidancePhases) {
      const documents = guidanceDocumentsFor(spec)
      if (documents.length === 0) {
        missing.push(`${spec.name} (no matching guidance in the distribution)`)
        continue
      }
      for (const document of documents) {
        if (!document.content.includes('$AB_CONTEXT_DIR/guidance.json')) missing.push(document.name)
      }
    }
    expect(
      missing,
      `phases that can receive human guidance without a skill naming $AB_CONTEXT_DIR/guidance.json: ${missing.join(', ')}`,
    ).toEqual([])
  })

  test('the repository-authored verifier authority retains context and verdict terminals', () => {
    expect(setupReference).toBeDefined()
    expect(setupReference?.content).toContain('Run `ab context`')
    expect(setupReference?.content).toContain('`$AB_CONTEXT_DIR/guidance.json`')
    expect(setupReference?.content).toContain('ab verdict pass --notes')
    expect(setupReference?.content).toContain('ab verdict fail --report')
    expect(setupReference?.content).toContain('ab verdict skip --reason')
  })

  test('no instruction points at `$AB_CONTEXT_DIR/findings.json` without the guidance alternative', () => {
    const offenders: string[] = []
    for (const spec of guidancePhases) {
      if (spec.inputs.findings !== 'current') continue
      const skill = byInstallName.get(spec.skill)
      if (skill === undefined) continue
      for (const block of skill.content.split(/\n\s*\n/)) {
        if (!block.includes('$AB_CONTEXT_DIR/findings.json')) continue
        if (block.includes('$AB_CONTEXT_DIR/guidance.json')) continue
        offenders.push(`${spec.skill}:\n${block}`)
      }
    }
    expect(
      offenders,
      `instructions naming $AB_CONTEXT_DIR/findings.json on a round that may carry guidance instead:\n${offenders.join('\n---\n')}`,
    ).toEqual([])
  })
})

/** The blank-line-separated block that opens with the shared bold lead. */
function optimizationParagraph(content: string): string | undefined {
  return content
    .split(/\n\s*\n/)
    .find((block) => block.trimStart().startsWith('**Optimization nodes.**'))
}

describe('optimization-node marker guidance', () => {
  test('ab-spec, ab-tickets and ab-guide state the marker in the same words', () => {
    const paragraphs = ['ab-spec', 'ab-tickets', 'ab-guide'].map((name) => {
      const paragraph = optimizationParagraph(byInstallName.get(name)?.content ?? '')
      expect(paragraph, `${name} has no "Optimization nodes" paragraph`).toBeDefined()
      return {
        name,
        text: paragraph!
          .replace(/\]\([^)]*\)/g, ']')
          .replace(/\s+/g, ' ')
          .trim(),
      }
    })
    for (const { name, text } of paragraphs) {
      expect(text, name).toContain('`autobuild-objective`')
      expect(text, name).toBe(paragraphs[0]!.text)
    }
  })

  test('the optimization-node reference is delivered in the ab-guide install tree', () => {
    const reference = guide?.files.find((file) => file.path === 'references/optimization-nodes.md')
    expect(reference).toBeDefined()
    expect(reference?.content).toContain('`autobuild-objective`')
  })
})

describe('optimization proposer guidance', () => {
  const propose = byInstallName.get('ab-propose')
  const text = (propose?.content ?? '').replace(/\s+/g, ' ')

  test('ab-propose is installed as a runner-only phase skill', () => {
    expect(propose).toBeDefined()
    expect(propose?.content).toContain('name: ab-propose')
    expect(propose?.content).toContain('disable-model-invocation: true')
    expect(PHASE_SPECS.propose?.skill).toBe('ab-propose')
  })

  test('it reads the attempt ledger before anything else', () => {
    expect(text).toContain('Read `ledger.json` first.')
    expect(text.indexOf('`ledger.json` first')).toBeLessThan(text.indexOf('Read `objective.json`'))
  })

  test('it treats a near miss as a refined new attempt with a new id', () => {
    expect(text).toContain('Treat a near miss as a candidate for a refined new attempt.')
    expect(text).toContain('new attempt with a new id')
    expect(text).toContain("never reuse the near miss's id")
  })

  test('it never exploits how the metric is measured', () => {
    expect(text).toContain('Never exploit how the metric is measured.')
    expect(text).toMatch(/special-cases the harness, the eval or the benchmark/)
  })

  test('it proposes nothing when the ideas run out, and never creates tickets', () => {
    expect(text).toContain('When no promising strategy remains, propose nothing and say why.')
    expect(text).toContain('`ab propose --none')
    expect(text).toContain('Two consecutive empty proposals stop the node as `exhausted`')
    expect(text).toContain('Never create tickets yourself')
  })
})
