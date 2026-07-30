/**
 * Review-skill prose guards: the two rules that decide how a review round
 * ends — what a reviewer puts in `persists`, and which severity a finding
 * gets.
 *
 * Both are load-bearing and neither is enforceable in code. `persists` chains
 * are the only input to the kernel's stall guard, so the rule that decides
 * whether a chain continues decides when a build escalates. Severity has no
 * mechanical effect anywhere in `src/` — `blocking` and `important` alike
 * cost the producer a revision round purely by skill convention — so the only
 * thing keeping an immaterial true defect from spending a round is the
 * calibration text itself. Delete either rule and every test still passes
 * unless it is anchored here.
 *
 * Each rule must say the same thing in `plan-review` and `code-review` — the
 * plan loop and the code loop are the same loop as far as `stallRounds` and
 * severity are concerned — and each must sit in the `## Writing findings`
 * section, where a reviewer choosing a `persists` id or a level is already
 * reading. Both properties are asserted rather than trusted, because prose
 * cannot be type-checked.
 *
 * The anchors are whole sentences of the shared rules, asserted one at a
 * time, so a failure names the sentence that was dropped instead of reporting
 * that a paragraph "changed". They are normalized for whitespace: every skill
 * file wraps at ~76 columns, and an anchor carrying a hard newline would break
 * on the next reflow rather than on a real regression.
 */
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DIST_ROOT = resolve(import.meta.dir, '..', '..')

async function readSkill(...segments: string[]): Promise<string> {
  return await readFile(join(DIST_ROOT, ...segments), 'utf8')
}

const planReview = await readSkill('skills', 'plan-review', 'SKILL.md')
const installedPlanReview = await readSkill('.agents', 'skills', 'ab-plan-review', 'SKILL.md')
const pristinePlanReview = await readSkill(
  '.agents',
  'skills',
  '.ab-pristine',
  'ab-plan-review',
  'SKILL.md',
)
const codeReview = await readSkill('skills', 'code-review', 'SKILL.md')
const installedCodeReview = await readSkill('.agents', 'skills', 'ab-code-review', 'SKILL.md')
const pristineCodeReview = await readSkill(
  '.agents',
  'skills',
  '.ab-pristine',
  'ab-code-review',
  'SKILL.md',
)

const reviewSkills = [
  ['plan-review (canonical)', planReview],
  ['plan-review (installed)', installedPlanReview],
  ['plan-review (pristine)', pristinePlanReview],
  ['code-review (canonical)', codeReview],
  ['code-review (installed)', installedCodeReview],
  ['code-review (pristine)', pristineCodeReview],
] as const

/** Collapse wrapping so anchors survive a reflow. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/**
 * The `## Writing findings` section only. Extracting the section is what
 * proves placement: the rule has to be where `persists` is chosen, not in a
 * preamble a reviewer skims once.
 */
function findingsSection(text: string): string | undefined {
  const heading = '## Writing findings'
  const start = text.indexOf(heading)
  if (start === -1) return undefined
  const after = start + heading.length
  const next = text.indexOf('\n## ', after)
  return next === -1 ? text.slice(after) : text.slice(after, next)
}

/**
 * The shared rule, sentence by sentence: the definition, the applicable test,
 * the disposition for a new instance of an already-fixed defect class, and
 * the preserved duty not to let a dodged finding look fresh. Byte-identical
 * text in both review skills is what makes "worded symmetrically for the plan
 * loop and the code loop" a mechanical property instead of a judgment.
 *
 * The first and third sentences share literal phrases with `ab-guide`'s
 * account of the same rule; `guide-skill.test.ts` asserts those phrases
 * against the guide, so an edit to either side fails the other side's test.
 */
const RULE_SENTENCES = [
  '`persists` means the defect a prior finding named is still present in the work under review — not that a new problem falls in the same category as one already fixed.',
  'Test it that way: if the exact defect the prior finding named is gone, the chain ends there, however closely your new finding resembles it.',
  'A new instance of a defect class whose reported instance was fixed is fresh work and starts its own chain — raise it with no `persists` link.',
  'Mark honestly in both directions: neither re-litigate a resolved finding nor let a dodged one look fresh, because the kernel mechanically escalates a chain that persists too long, and a stalemate is the only thing that counter can usefully measure.',
] as const

const RULE = RULE_SENTENCES.join(' ')

describe('review skills — persistence marking', () => {
  test.each(reviewSkills)('%s states the rule in its findings section', (_label, text) => {
    const section = findingsSection(text)
    expect(section).toBeDefined()
    const compact = normalize(section ?? '')
    for (const sentence of RULE_SENTENCES) {
      expect(compact).toContain(sentence)
    }
  })

  test('plan-review and code-review carry the rule as one identical paragraph', () => {
    for (const [, text] of reviewSkills) {
      expect(normalize(findingsSection(text) ?? '')).toContain(RULE)
    }
  })

  test('the superseded loose wording is gone, not left beside the rule', () => {
    // Two rules in one section is worse than the old one alone: a reviewer
    // reading "the same disagreement, even if reworded" plus the narrowed
    // test gets to pick.
    expect(normalize(findingsSection(planReview) ?? '')).not.toContain(
      'so mark honestly: neither re-litigate resolved findings',
    )
    expect(normalize(findingsSection(codeReview) ?? '')).not.toContain('Mark persistence honestly:')
  })
})

/**
 * The shared severity calibration, sentence by sentence: what severity
 * measures, the three levels defined against something nameable, the
 * disposition for a true-but-immaterial defect, and the two limits on
 * inventing a bar the spec did not set. The level bullets carry their `- `
 * prefix because `normalize()` collapses a markdown list into inline text.
 *
 * Byte-identical text in both review skills is what makes "the plan loop and
 * the code loop stay symmetric" a mechanical property instead of a judgment.
 *
 * Four phrases here are shared literally with `ab-guide`'s account of the
 * same rule; `guide-skill.test.ts` asserts those against the guide, so an
 * edit to either side fails the other side's test.
 */
const CALIBRATION_SENTENCES = [
  'Severity measures proportion, not certainty.',
  "Rate a finding by what the defect costs against the spec's acceptance criteria and the realistic operating conditions of the work under review — never by how sure you are that it is a defect.",
  'Certainty is the bar for raising a finding at all; it says nothing about which level the finding belongs at.',
  '- `blocking` — name the acceptance criterion the defect defeats. Approving would deliver work the spec does not accept.',
  '- `important` — name the acceptance criterion or stated invariant the defect puts at material risk under realistic conditions, short of defeating it outright.',
  '- `minor` — real and in scope, but nothing above turns on it.',
  '`blocking` and `important` both cost the producer a revision round, so if you cannot name that criterion or invariant, the finding does not belong at either level.',
  'A true defect that puts no acceptance criterion at risk, breaks no stated invariant, and is unreachable under realistic input is `ab observe`, not a finding — the same disposition an out-of-scope discovery gets.',
  'Do not raise a bar the spec set: where the spec bounds a failure model or an operating condition, conformance is measured against that bound, and a stricter model you would have chosen is not a defect.',
  "Hostile or pathological input that the surface's contract does not promise to handle is `minor` or an observation, unless a security boundary, an acceptance criterion, or a stated invariant makes it material.",
] as const

/**
 * Valid because the block is contiguous: every gap between its parts — a
 * paragraph break, a list break, a wrap — normalizes to exactly one space.
 */
const CALIBRATION = CALIBRATION_SENTENCES.join(' ')

/**
 * The counterpart on the approve side. Without it, a reviewer who correctly
 * files an immaterial defect as an observation could still read the approve
 * instruction as barring approval while a known defect stands.
 */
const APPROVE_SENTENCE =
  'Known immaterial defects are not a reason to withhold approval — record them with `ab observe` and approve.'

describe('review skills — severity calibration', () => {
  test.each(reviewSkills)('%s calibrates severity in its findings section', (_label, text) => {
    const section = findingsSection(text)
    expect(section).toBeDefined()
    const compact = normalize(section ?? '')
    for (const sentence of CALIBRATION_SENTENCES) {
      expect(compact).toContain(sentence)
    }
  })

  test('plan-review and code-review carry the calibration as one identical block', () => {
    // A per-sentence failure above means a sentence was dropped; a failure
    // here with those passing means the two skills' text diverged. Diff the
    // `## Writing findings` sections rather than loosening the anchor.
    for (const [, text] of reviewSkills) {
      expect(normalize(findingsSection(text) ?? '')).toContain(CALIBRATION)
    }
  })

  test.each(reviewSkills)(
    '%s says an observation-carrying result is approvable',
    (_label, text) => {
      expect(normalize(findingsSection(text) ?? '')).toContain(APPROVE_SENTENCE)
    },
  )

  test('the superseded severity gloss is gone, not left beside the calibration', () => {
    // The old bullet defined the levels by consequence to approval, which is
    // exactly the non-proportional rule the calibration replaces. Leaving it
    // in place would hand a reviewer two rules to choose between.
    expect(normalize(findingsSection(planReview) ?? '')).not.toContain(
      "(should fix, wouldn't sink the build)",
    )
  })
})

describe('review skills — vendored copies', () => {
  /**
   * Hand-derived rather than routed through `rewriteSkillSource`, so a change
   * to the install transform has to be restated here deliberately instead of
   * silently redefining what the checked-in mirrors are compared against.
   */
  function installForm(canonical: string, name: string): string {
    const renamed = canonical.replace(`\nname: ${name}\n`, `\nname: ab-${name}\n`)
    return renamed.replace(/^(description: .*)$/m, '$1\ndisable-model-invocation: true')
  }

  test('checked-in live and pristine plan-review match the canonical install form', () => {
    const expected = installForm(planReview, 'plan-review')
    expect(expected).not.toBe(planReview)
    expect(installedPlanReview).toBe(expected)
    expect(pristinePlanReview).toBe(expected)
  })

  test('checked-in live and pristine code-review match the canonical install form', () => {
    const expected = installForm(codeReview, 'code-review')
    expect(expected).not.toBe(codeReview)
    expect(installedCodeReview).toBe(expected)
    expect(pristineCodeReview).toBe(expected)
  })
})
