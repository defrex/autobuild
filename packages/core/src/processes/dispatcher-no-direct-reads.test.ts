import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * AUT-647: the repository view is the only path by which tick stages observe
 * repository and build state. The Dispatcher wraps `deps.store` in its view
 * once, in the constructor, and every stage uses `this.store` thereafter; the
 * frontend's tick-path journal reads go through its view too. A raw-store read
 * reintroduced into either file fails here, naming the line.
 *
 * `orchestrator-tick.ts` and the operator sandbox service are handed the view
 * and read through whatever store they are given, so they cannot be told apart
 * by text; the counting tests in `dispatcher.test.ts` prove them behaviorally.
 */

const here = import.meta.dir

function lines(file: string): string[] {
  return readFileSync(join(here, file), 'utf8').split('\n')
}

/** The lines of one method body, from its declaration to the next member. */
function methodBody(source: string[], declaration: RegExp): { line: number; text: string }[] {
  const start = source.findIndex((text) => declaration.test(text))
  expect(start, `declaration ${declaration} not found`).toBeGreaterThanOrEqual(0)
  const indent = /^\s*/.exec(source[start]!)![0]
  const body: { line: number; text: string }[] = []
  for (let i = start + 1; i < source.length; i += 1) {
    const text = source[i]!
    if (text.startsWith(`${indent}}`) && text.trim() === '}') break
    body.push({ line: i + 1, text })
  }
  return body
}

describe('tick stages read state only through the repository view', () => {
  test('dispatcher.ts never touches deps.store outside the constructor wrap', () => {
    const offenders = lines('dispatcher.ts')
      .map((text, index) => ({ line: index + 1, text }))
      .filter(({ text }) => /deps\.store/.test(text) && !/^\s*(\/\/|\*|\/\*)/.test(text))
      .filter(
        ({ text }) =>
          !/deps\.store instanceof RepoViewStore|\? deps\.store$|new RepoViewStore\(deps\.store/.test(
            text,
          ),
      )
    expect(offenders.map(({ line, text }) => `dispatcher.ts:${line}: ${text.trim()}`)).toEqual([])
  })

  test('dispatcher.ts does not import the raw journal reader', () => {
    const offenders = lines('dispatcher.ts')
      .map((text, index) => ({ line: index + 1, text }))
      .filter(({ text }) => /readRepoEventsIfRecorded|getRepoStateEvents\(/.test(text))
      .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text))
    expect(offenders.map(({ line, text }) => `dispatcher.ts:${line}: ${text.trim()}`)).toEqual([])
  })

  test('the frontend callbacks the tick awaits read and write build state through the view', () => {
    const source = lines('../cli/dispatch.ts')
    const forbidden =
      /wiring\.store\.(?:getEvents|getRepoEvents|getRepoStateEvents|listBuilds|getRepoBuildDigests|append|appendIfCurrent|appendWithArtifacts|appendRepo|claimLease|releaseLease)\(/
    const offenders: string[] = []
    for (const declaration of [
      /private async launchRunner\(/,
      /private async settlePendingPublication\(/,
      /private async resolveBuildPipeline\(/,
      /private async recordInfrastructureFailure\(/,
    ]) {
      for (const { line, text } of methodBody(source, declaration)) {
        if (forbidden.test(text) && !/^\s*(\/\/|\*)/.test(text)) {
          offenders.push(`cli/dispatch.ts:${line}: ${text.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("the frontend's tick-path methods read the journal through the view", () => {
    const source = lines('../cli/dispatch.ts')
    const forbidden =
      /(?:wiring\.store|\bstore)\.(?:getRepoStateEvents|getRepoEvents|getEvents|listBuilds|getRepoBuildDigests)\(|readRepoEventsIfRecorded\(/
    const offenders: string[] = []
    for (const declaration of [
      /private async readDispatchSettings\(/,
      /private dispatcherTick\(/,
      /private async classifyHostedHarvestOutcome\(/,
    ]) {
      for (const { line, text } of methodBody(source, declaration)) {
        if (forbidden.test(text) && !/^\s*(\/\/|\*)/.test(text)) {
          offenders.push(`cli/dispatch.ts:${line}: ${text.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
