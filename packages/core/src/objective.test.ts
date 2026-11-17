import { describe, expect, test } from 'bun:test'
import {
  applyObjectiveRevisions,
  formatObjective,
  objectiveBlocks,
  objectiveFieldDiff,
  objectiveRefusals,
  objectiveRulerChanged,
  parseObjective,
  revisableChangesSchema,
  REJECTED_ROLE_REFUSAL,
  WORK_TICKET_OBJECTIVE_REFUSAL,
  type Objective,
} from './objective'

/** RFC 0005 §4.1, verbatim. */
const RFC_COMMAND_BLOCK = `\`\`\`autobuild-objective
purpose = """
p95 latency of the catalog search query, because users wait on it at every
keystroke. Results, their order and the query's semantics must not change.
"""

[metric]
kind = "command"                 # or "panel" (§8)
command = "bun bench/search.ts"  # prints one JSON object: {"value": <number>}
direction = "minimize"
samples = 7                      # paired runs per side (§7.3)
harness = ["bench/search/**", "bench/fixtures/catalog.sql"]

[target]
threshold = 40                   # milliseconds; optional
epsilon = { relative = 0.03 }    # or { absolute = 2 }

[budget]                         # at least one limit is required
maxAttempts = 60
maxHours = 24

[stop]
plateau = { attempts = 12 }      # optional (§9.1)
mode = "abort"                   # or "drain"; default "abort"

[proposer]
concurrency = 4                  # attempts in flight
\`\`\``

/** RFC 0005 §8's panel metric, verbatim, with the rest of an objective. */
const RFC_PANEL_BLOCK = `\`\`\`autobuild-objective
purpose = "Clearer onboarding prose without losing accuracy."

[metric]
kind = "panel"
judges = 5
rubric = "evals/prose-rubric.md"   # a harness path
harness = ["evals/**"]

[target]
threshold = 0.8
epsilon = { absolute = 0.1 }

[budget]
maxAttempts = 20
\`\`\``

const spec = (...parts: string[]) =>
  [
    '## What and why',
    '',
    'Make it faster.',
    '',
    ...parts,
    '',
    '## Acceptance criteria',
    '- [ ] fast',
  ].join('\n')

function block(toml: string): string {
  return ['```autobuild-objective', toml, '```'].join('\n')
}

const MINIMAL = [
  'purpose = "faster"',
  '[metric]',
  'kind = "command"',
  'command = "bun bench.ts"',
  'direction = "minimize"',
  'samples = 3',
  'harness = ["bench/**"]',
  '[target]',
  'epsilon = { absolute = 2 }',
  '[budget]',
  'maxAttempts = 5',
].join('\n')

function objectiveOf(body: string): Objective {
  const parsed = parseObjective(body)
  if (!('objective' in parsed)) throw new Error(`expected an objective: ${JSON.stringify(parsed)}`)
  return parsed.objective
}

function refusalOf(body: string): string {
  const parsed = parseObjective(body)
  if (!('refusal' in parsed)) throw new Error(`expected a refusal: ${JSON.stringify(parsed)}`)
  return parsed.refusal
}

describe('the autobuild-objective marker', () => {
  test('the RFC command example parses as a valid objective', () => {
    const objective = objectiveOf(spec(RFC_COMMAND_BLOCK))
    expect(objective.metric).toEqual({
      kind: 'command',
      command: 'bun bench/search.ts',
      direction: 'minimize',
      samples: 7,
      harness: ['bench/search/**', 'bench/fixtures/catalog.sql'],
    })
    expect(objective.target).toEqual({ threshold: 40, epsilon: { relative: 0.03 } })
    expect(objective.budget).toEqual({ maxAttempts: 60, maxHours: 24 })
    expect(objective.stop).toEqual({ plateau: { attempts: 12 }, mode: 'abort' })
    expect(objective.proposer).toEqual({ concurrency: 4 })
  })

  test('the RFC panel example parses as a valid objective', () => {
    const objective = objectiveOf(spec(RFC_PANEL_BLOCK))
    expect(objective.metric).toEqual({
      kind: 'panel',
      judges: 5,
      rubric: 'evals/prose-rubric.md',
      harness: ['evals/**'],
    })
  })

  test('the RFC nested markdown example does not count', () => {
    const nested = ['````markdown', RFC_COMMAND_BLOCK, '````'].join('\n')
    expect(objectiveBlocks(spec(nested))).toEqual([])
    expect(parseObjective(spec(nested))).toEqual({ absent: true })
  })

  test('a tilde fence counts and closes only on tildes', () => {
    const body = spec(['~~~autobuild-objective', MINIMAL, '```', '~~~'].join('\n'))
    expect(objectiveBlocks(body)).toEqual([`${MINIMAL}\n\`\`\``])
    expect(objectiveOf(spec(['~~~ autobuild-objective ', MINIMAL, '~~~'].join('\n'))).purpose).toBe(
      'faster',
    )
  })

  test('false positives never count', () => {
    const cases = [
      ['## Objective', '', 'Minimize p95 latency within 60 attempts.'].join('\n'),
      ['```toml', MINIMAL, '```'].join('\n'),
      'Our autobuild-objective is to minimize latency; budget 60 attempts.',
      'Inline `autobuild-objective` code does not count.',
      'Inline ```autobuild-objective``` code does not count either.',
      ['    ```autobuild-objective', `    ${MINIMAL.split('\n').join('\n    ')}`, '    ```'].join(
        '\n',
      ),
      ['> ```autobuild-objective', `> ${MINIMAL.split('\n').join('\n> ')}`, '> ```'].join('\n'),
      ['- item', '', '      ```autobuild-objective', '      purpose = "x"', '      ```'].join('\n'),
      ['```Autobuild-Objective', MINIMAL, '```'].join('\n'),
      ['```autobuild-objective toml', MINIMAL, '```'].join('\n'),
      ['```autobuild-objectives', MINIMAL, '```'].join('\n'),
    ]
    for (const body of cases) expect(parseObjective(spec(body))).toEqual({ absent: true })
  })

  test('a fence indented up to three spaces counts', () => {
    expect(
      objectiveBlocks(spec(['   ```autobuild-objective', 'purpose = "x"', '   ```'].join('\n'))),
    ).toEqual(['purpose = "x"'])
  })

  test('a closing fence must be at least as long as the opening one', () => {
    const body = spec(['````autobuild-objective', MINIMAL, '```', '````'].join('\n'))
    expect(objectiveBlocks(body)).toEqual([`${MINIMAL}\n\`\`\``])
  })

  test('two blocks refuse', () => {
    expect(refusalOf(spec(block(MINIMAL), '', block(MINIMAL)))).toBe(
      'exactly one autobuild-objective block (found 2)',
    )
  })

  test('an unterminated block refuses', () => {
    expect(refusalOf(['```autobuild-objective', MINIMAL].join('\n'))).toBe(
      'a valid autobuild-objective block: the fence is never closed',
    )
  })
})

describe('objective validation', () => {
  test('defaults apply', () => {
    const objective = objectiveOf(spec(block(MINIMAL)))
    expect(objective.stop).toEqual({ mode: 'abort' })
    expect(objective.proposer).toEqual({ concurrency: 1 })
    expect(objective.target.threshold).toBeUndefined()
  })

  test('a TOML syntax error names the line', () => {
    expect(refusalOf(block('purpose = = "x"'))).toBe(
      'a valid autobuild-objective block: TOML syntax error at line 1: invalid value',
    )
  })

  test('an unknown key names its path', () => {
    expect(refusalOf(block(MINIMAL.replace('command = ', 'cmd = "x"\ncommand = ')))).toBe(
      'a valid autobuild-objective block: unknown field metric.cmd',
    )
    expect(refusalOf(block(`colour = "red"\n${MINIMAL}`))).toBe(
      'a valid autobuild-objective block: unknown field colour',
    )
  })

  test('a missing or invalid field is named', () => {
    expect(refusalOf(block(MINIMAL.replace('samples = 3', 'samples = 0')))).toStartWith(
      'a valid autobuild-objective block: metric.samples: ',
    )
    expect(refusalOf(block(MINIMAL.replace('samples = 3\n', '')))).toBe(
      'a valid autobuild-objective block: metric.samples: is required',
    )
    expect(refusalOf(block(MINIMAL.replace('purpose = "faster"\n', '')))).toBe(
      'a valid autobuild-objective block: purpose: is required',
    )
    expect(refusalOf(block(MINIMAL.replace('kind = "command"', 'kind = "score"')))).toBe(
      'a valid autobuild-objective block: metric.kind: must be "command" or "panel"',
    )
    expect(
      refusalOf(block(MINIMAL.replace('{ absolute = 2 }', '{ absolute = 2, relative = 0.1 }'))),
    ).toBe(
      'a valid autobuild-objective block: target.epsilon: set exactly one of absolute or relative',
    )
    expect(refusalOf(block(MINIMAL.replace('{ absolute = 2 }', '{ relative = 1.5 }')))).toStartWith(
      'a valid autobuild-objective block: target.epsilon.relative: ',
    )
  })

  test('an objective with no budget limit refuses naming both limits', () => {
    const noLimit =
      'a budget limit in the autobuild-objective block: set budget.maxAttempts or budget.maxHours'
    expect(refusalOf(block(MINIMAL.replace('maxAttempts = 5', '')))).toBe(noLimit)
    expect(refusalOf(block(MINIMAL.replace('[budget]\nmaxAttempts = 5', '')))).toBe(noLimit)
    expect(objectiveOf(block(MINIMAL.replace('maxAttempts = 5', 'maxHours = 1.5'))).budget).toEqual(
      {
        maxHours: 1.5,
      },
    )
  })

  test('panel fields are refused for a command metric and command fields for a panel', () => {
    expect(refusalOf(block(MINIMAL.replace('samples = 3', 'samples = 3\njudges = 4')))).toBe(
      'a valid autobuild-objective block: metric.judges: not allowed for a command metric',
    )
    const panel = RFC_PANEL_BLOCK.replace('judges = 5', 'judges = 5\ndirection = "maximize"')
    expect(refusalOf(panel)).toBe(
      'a valid autobuild-objective block: metric.direction: not allowed for a panel metric (panels always maximize the win rate)',
    )
  })

  test('panel targets are win rates', () => {
    expect(refusalOf(RFC_PANEL_BLOCK.replace('{ absolute = 0.1 }', '{ relative = 0.1 }'))).toBe(
      'a valid autobuild-objective block: target.epsilon: a panel accepts only an absolute epsilon below 0.5',
    )
    expect(refusalOf(RFC_PANEL_BLOCK.replace('threshold = 0.8', 'threshold = 0.4'))).toBe(
      'a valid autobuild-objective block: target.threshold: a panel threshold is a win rate in (0.5, 1]',
    )
  })

  test('harness entries are path selectors and the rubric sits inside them', () => {
    expect(refusalOf(RFC_PANEL_BLOCK.replace('"evals/prose-rubric.md"', '"docs/rubric.md"'))).toBe(
      'a valid autobuild-objective block: metric.rubric: must be inside metric.harness',
    )
    expect(refusalOf(RFC_PANEL_BLOCK.replace('"evals/prose-rubric.md"', '"evals/*.md"'))).toBe(
      'a valid autobuild-objective block: metric.rubric: must be a literal path, not a glob',
    )
    expect(refusalOf(block(MINIMAL.replace('["bench/**"]', '["bench/**", "/bench/**"]')))).toBe(
      'a valid autobuild-objective block: metric.harness[1]: path selectors must be repository-relative, not absolute',
    )
    expect(refusalOf(block(MINIMAL.replace('["bench/**"]', '["bench/{a,b}"]')))).toStartWith(
      'a valid autobuild-objective block: metric.harness[0]: path selectors support only',
    )
    expect(refusalOf(block(MINIMAL.replace('["bench/**"]', '[]')))).toStartWith(
      'a valid autobuild-objective block: metric.harness: ',
    )
  })
})

describe('objectiveRefusals', () => {
  const node = { kind: 'node' as const, rejectedState: 'Rejected' }

  test('no block never refuses', () => {
    expect(objectiveRefusals(spec(), node)).toEqual([])
    expect(objectiveRefusals(spec(), { kind: 'work', rejectedState: undefined })).toEqual([])
    expect(objectiveRefusals(spec(), { kind: 'node', rejectedState: undefined })).toEqual([])
  })

  test('a valid block on a node with a rejected role opens', () => {
    expect(objectiveRefusals(spec(block(MINIMAL)), node)).toEqual([])
  })

  test('a work ticket carrying the block is refused naming the block', () => {
    expect(
      objectiveRefusals(spec(block(MINIMAL)), { kind: 'work', rejectedState: 'Rejected' }),
    ).toEqual([WORK_TICKET_OBJECTIVE_REFUSAL])
    expect(WORK_TICKET_OBJECTIVE_REFUSAL).toContain('autobuild-objective')
  })

  test('a node without a rejected role is refused naming the setting', () => {
    expect(
      objectiveRefusals(spec(block(MINIMAL)), { kind: 'node', rejectedState: undefined }),
    ).toEqual([REJECTED_ROLE_REFUSAL])
    expect(REJECTED_ROLE_REFUSAL).toContain('[tickets].rejectedState')
  })

  test('every refusal is reported', () => {
    expect(
      objectiveRefusals(spec(block(MINIMAL), block(MINIMAL)), {
        kind: 'node',
        rejectedState: undefined,
      }),
    ).toEqual(['exactly one autobuild-objective block (found 2)', REJECTED_ROLE_REFUSAL])
  })
})

describe('revisions', () => {
  const base = objectiveOf(spec(RFC_COMMAND_BLOCK))

  test('changes apply in order', () => {
    const effective = applyObjectiveRevisions(base, [
      { threshold: 35, plateau: 8 },
      { maxHours: 36, epsilon: { absolute: 1 }, stopMode: 'drain' },
      { threshold: 30, concurrency: 2, maxAttempts: 90 },
    ])
    expect(effective.target).toEqual({ threshold: 30, epsilon: { absolute: 1 } })
    expect(effective.budget).toEqual({ maxAttempts: 90, maxHours: 36 })
    expect(effective.stop).toEqual({ plateau: { attempts: 8 }, mode: 'drain' })
    expect(effective.proposer).toEqual({ concurrency: 2 })
    expect(base.target.threshold).toBe(40)
  })

  test('the change schema is strict and nonempty', () => {
    expect(revisableChangesSchema.safeParse({}).success).toBe(false)
    expect(revisableChangesSchema.safeParse({ metric: {} }).success).toBe(false)
    expect(revisableChangesSchema.safeParse({ plateau: 0 }).success).toBe(false)
    expect(revisableChangesSchema.safeParse({ threshold: 2 }).success).toBe(true)
  })

  test('the field diff names every field that differs from the ticket block', () => {
    const effective = applyObjectiveRevisions(base, [{ threshold: 35, plateau: 8 }])
    expect(objectiveFieldDiff(effective, base)).toEqual(['threshold', 'plateau'])
    expect(objectiveFieldDiff(base, structuredClone(base))).toEqual([])
    expect(objectiveFieldDiff(base, undefined)).toHaveLength(9)
  })

  test('the field diff ignores key order', () => {
    const reordered = JSON.parse(
      JSON.stringify({ ...base, metric: { harness: base.metric.harness, ...base.metric } }),
    ) as Objective
    expect(objectiveFieldDiff(base, reordered)).toEqual([])
  })

  test('a new ruler starts when the metric changes, or a panel purpose', () => {
    expect(objectiveRulerChanged(base, applyObjectiveRevisions(base, [{ threshold: 1 }]))).toBe(
      false,
    )
    expect(objectiveRulerChanged(base, { ...base, purpose: 'other' })).toBe(false)
    expect(
      objectiveRulerChanged(base, { ...base, metric: { ...base.metric, harness: ['b/**'] } }),
    ).toBe(true)
    const panel = objectiveOf(spec(RFC_PANEL_BLOCK))
    expect(objectiveRulerChanged(panel, { ...panel, purpose: 'other' })).toBe(true)
  })

  test('formatting marks revised fields', () => {
    const effective = applyObjectiveRevisions(base, [{ threshold: 35 }])
    const lines = formatObjective(effective, new Set(['threshold']))
    expect(lines).toContain('threshold: 35 (revised)')
    expect(lines).toContain('epsilon: 3% relative')
    expect(lines).toContain('metric: command `bun bench/search.ts`, minimize, 7 samples')
    expect(lines).toContain('harness: bench/search/**, bench/fixtures/catalog.sql')
    expect(lines.filter((line) => line.endsWith('(revised)'))).toHaveLength(1)
  })
})
