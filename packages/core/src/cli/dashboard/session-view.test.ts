/**
 * The shared session-view projection (session-view.ts) — pure, so every
 * visible-element acceptance criterion is assertable here without a terminal.
 * The document-adapter tests are driven by `assembleUIMessageDocument`'s real
 * output, never hand-built part guesses, so an SDK upgrade that changes the
 * finalized shape breaks here first.
 */
import { describe, expect, test } from 'bun:test'
import { assembleUIMessageDocument } from '../../store/streams/assemble'
import type { StreamPart } from '../../store/streams/types'
import {
  abortPart,
  errorPart,
  finishPart,
  finishStepPart,
  promptPart,
  reasoningDeltaPart,
  reasoningEndPart,
  reasoningStartPart,
  sessionPart,
  startPart,
  startStepPart,
  textDeltaPart,
  textEndPart,
  textStartPart,
  toolInputPart,
  toolOutputPart,
  truncationPart,
} from '../../ports/runner/stream-parts'
import { projectSessionDocument, projectSessionParts } from './session-view'

/** A representative full-turn part sequence, in store-sequence order. */
function representativeParts(): StreamPart[] {
  return [
    sessionPart({
      session: 's_watch',
      role: 'implement',
      runner: 'pi',
      model: 'zai/glm',
      phase: 'implement',
      round: 2,
    }),
    promptPart('implement the session view'),
    startPart('m1'),
    startStepPart(),
    reasoningStartPart('r1'),
    reasoningDeltaPart('r1', 'consider the projection '),
    reasoningDeltaPart('r1', 'before the pixels'),
    reasoningEndPart('r1'),
    textStartPart('t1'),
    textDeltaPart('t1', 'here is '),
    textDeltaPart('t1', 'the answer'),
    textEndPart('t1'),
    toolInputPart('call1', 'read_file', { path: 'src/x.ts', limit: 3 }),
    toolOutputPart('call1', Array.from({ length: 12 }, (_, i) => `row-${i}`).join('\n')),
    truncationPart(2048),
    errorPart('provider exploded'),
    abortPart('operator aborted'),
    { type: 'data-ab-future', data: { custom: true } },
    finishStepPart(),
    finishPart(),
  ]
}

describe('projectSessionParts', () => {
  test('a representative sequence renders every documented element in order', () => {
    const lines = projectSessionParts(representativeParts(), 200)
    const text = lines.join('\n')
    // Header line: role · runner · model · phase (round).
    expect(lines[0]).toBe('implement · pi · zai/glm · phase implement (round 2)')
    // Prompt labelled as such.
    expect(text).toContain('Prompt: implement the session view')
    // Reasoning visibly distinct from answer text, without color.
    expect(text).toContain('~ consider the projection before the pixels')
    // Answer text as prose, deltas concatenated per id.
    expect(text).toContain('here is the answer')
    // One tool line + its capped output with the withheld count.
    expect(text).toContain('read_file({"path":"src/x.ts","limit":3})')
    expect(text).toContain('row-0')
    expect(text).not.toContain('row-11')
    expect(text).toContain('… 4 more rows withheld')
    // Truncation marker exactly where the runner emitted it.
    expect(text).toContain('… 2048 bytes truncated')
    // Error and abort as legible lines.
    expect(text).toContain('ERROR: provider exploded')
    expect(text).toContain('ABORTED: operator aborted')
    // Unknown data-* part renders legibly.
    expect(text).toContain('data data-ab-future')
    // Step boundaries as separators; the leading start-step does not
    // double-separate the header.
    expect(text).toContain('── step ──')
    expect(lines.indexOf('── step ──')).toBeGreaterThan(lines.indexOf('read_file('))
    // Order: the truncation marker sits between the tool output and the error.
    const withheld = lines.indexOf('… 4 more rows withheld')
    const trunc = lines.indexOf('… 2048 bytes truncated')
    const error = lines.indexOf('ERROR: provider exploded')
    expect(withheld).toBeLessThan(trunc)
    expect(trunc).toBeLessThan(error)
  })

  test('a tool call still awaiting output renders the waiting line (live mid-turn)', () => {
    const lines = projectSessionParts(
      [
        sessionPart({ session: 's', role: 'plan', runner: 'pi', phase: 'plan' }),
        toolInputPart('call1', 'bash', { command: 'bun test' }),
      ],
      120,
    )
    const text = lines.join('\n')
    expect(text).toContain('bash({"command":"bun test"})')
    expect(text).toContain('waiting for output')
  })

  test('tool output resolves onto its input across chunk boundaries', () => {
    // The output part arrives in a LATER store chunk than the input part; the
    // projection is a pure function of the accumulated sequence, so the output
    // renders beneath the tool line wherever the input landed.
    const lines = projectSessionParts(
      [
        toolInputPart('call1', 'bash', { command: 'ls' }),
        textStartPart('t'),
        textDeltaPart('t', 'running'),
        toolOutputPart('call1', 'done'),
      ],
      120,
    )
    const tool = lines.findIndex((line) => line.startsWith('bash('))
    const output = lines.indexOf('done')
    expect(tool).toBeGreaterThanOrEqual(0)
    expect(output).toBeGreaterThan(tool)
    expect(lines).not.toContain('waiting for output')
  })

  test('absent session header part renders a neutral header line', () => {
    const lines = projectSessionParts([promptPart('hello')], 120)
    expect(lines[0]).toBe('unknown session')
    expect(lines).toContain('Prompt: hello')
  })

  test('non-data parts of unknown protocol types are ignored', () => {
    const lines = projectSessionParts(
      [
        sessionPart({ session: 's', role: 'plan', runner: 'pi', phase: 'plan' }),
        { type: 'file', mediaType: 'image/png', url: 'data:...' },
        { type: 'custom', kind: 'provider.thing' },
      ],
      120,
    )
    expect(lines.join('\n')).not.toContain('image/png')
    expect(lines.join('\n')).not.toContain('provider.thing')
  })

  test('stored parts are never altered', () => {
    const parts = representativeParts()
    const frozen = parts.map((part) => Object.freeze({ ...part }))
    const snapshot = JSON.stringify(frozen)
    projectSessionParts(frozen, 100)
    expect(JSON.stringify(frozen)).toBe(snapshot)
    // And the array itself is not reordered or lengthened.
    expect(frozen.map((part) => part.type)).toEqual(parts.map((part) => part.type))
  })

  test('prose wraps at the width and every reasoning line carries the mark', () => {
    const long = 'word '.repeat(60).trim()
    const lines = projectSessionParts(
      [
        sessionPart({ session: 's', role: 'plan', runner: 'pi', phase: 'plan' }),
        reasoningStartPart('r'),
        reasoningDeltaPart('r', long),
        reasoningEndPart('r'),
        textStartPart('t'),
        textDeltaPart('t', long),
        textEndPart('t'),
      ],
      40,
    )
    const reasoning = lines.filter((line) => line.startsWith('~ '))
    expect(reasoning.length).toBeGreaterThan(1)
    for (const line of reasoning) expect(line.length).toBeLessThanOrEqual(40)
    const prose = lines.filter((line) => !line.startsWith('~ '))
    expect(prose.length).toBeGreaterThan(1)
  })

  test('reasoning runs, tool calls, and text interleave in stream order', () => {
    const lines = projectSessionParts(
      [
        sessionPart({ session: 's', role: 'implement', runner: 'pi', phase: 'implement' }),
        startStepPart(),
        reasoningStartPart('r'),
        reasoningDeltaPart('r', 'first thought'),
        reasoningEndPart('r'),
        toolInputPart('c1', 'bash', { command: 'ls' }),
        toolOutputPart('c1', 'files'),
        textStartPart('t'),
        textDeltaPart('t', 'the listing'),
        textEndPart('t'),
      ],
      120,
    )
    const order = [
      lines.findIndex((l) => l.includes('first thought')),
      lines.findIndex((l) => l.startsWith('bash(')),
      lines.findIndex((l) => l === 'files'),
      lines.findIndex((l) => l.includes('the listing')),
    ]
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})

describe('projectSessionDocument (driven by assembleUIMessageDocument output)', () => {
  test('the finalized document projects to the same vocabulary', async () => {
    const { document } = await assembleUIMessageDocument(representativeParts())
    const lines = projectSessionDocument(document, 200)
    const text = lines.join('\n')
    expect(lines[0]).toBe('implement · pi · zai/glm · phase implement (round 2)')
    expect(text).toContain('Prompt: implement the session view')
    expect(text).toContain('~ consider the projection before the pixels')
    expect(text).toContain('here is the answer')
    expect(text).toContain('read_file({"path":"src/x.ts","limit":3})')
    expect(text).toContain('… 4 more rows withheld')
    expect(text).toContain('data data-ab-future')
    // The SDK's assembly drops `error`/`abort` chunks — they never become
    // message parts — so those elements are parts-path-only by construction.
    expect(text).not.toContain('ERROR:')
    expect(text).not.toContain('ABORTED:')
  })

  test('an awaiting tool part in the document renders the waiting line', async () => {
    const { document } = await assembleUIMessageDocument([
      sessionPart({ session: 's', role: 'implement', runner: 'pi', phase: 'implement' }),
      startPart('m1'),
      toolInputPart('call1', 'bash', { command: 'ls' }),
    ])
    const text = projectSessionDocument(document, 120).join('\n')
    expect(text).toContain('bash({"command":"ls"})')
    expect(text).toContain('waiting for output')
  })

  test('an output-error tool part renders its error text', async () => {
    const { document } = await assembleUIMessageDocument([
      sessionPart({ session: 's', role: 'implement', runner: 'pi', phase: 'implement' }),
      startPart('m1'),
      toolInputPart('call1', 'bash', { command: 'ls' }),
      { type: 'tool-output-error', toolCallId: 'call1', errorText: 'permission denied' },
    ])
    expect(projectSessionDocument(document, 120).join('\n')).toContain('ERROR: permission denied')
  })

  test('a pruned-chunk fallback document with no tool parts renders plain prose', async () => {
    const { document } = await assembleUIMessageDocument([
      sessionPart({ session: 's', role: 'plan', runner: 'pi', phase: 'plan' }),
      promptPart('write the spec'),
      startPart('m1'),
      textStartPart('t'),
      textDeltaPart('t', 'the plan body'),
      textEndPart('t'),
      finishPart(),
    ])
    const lines = projectSessionDocument(document, 120)
    expect(lines).toContain('Prompt: write the spec')
    expect(lines).toContain('the plan body')
  })
})
