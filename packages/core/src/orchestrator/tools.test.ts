/**
 * The registry→AI-SDK tool binding's schema shaping (AUT-342): every entry's
 * model-facing schema must accept an input WITHOUT `repo` — the model is
 * never asked for a value it cannot know — and must refuse a supplied one,
 * so the session's repository is the only value a tool can ever target.
 *
 * The regression this pins (f_f46c7d1a): Zod 4 refuses to `.omit()` an
 * object that carries refinements and exposes no `withOptions` on unions, so
 * the naive strip dropped `tickets.update` from the tool set entirely and
 * left `builds.answer` / `harvest.control` unions with a required `repo` —
 * three tools the canonical skill teaches that the agent could not call.
 */
import { describe, expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { systemClock } from '../store/types'
import { buildRegistry } from '../operator/registry'
import { registryTools } from './tools'

const REPO = 'https://github.com/acme/widgets'

function toolsForStore() {
  const store = new MemoryBuildStore({ clock: systemClock })
  const registry = buildRegistry({ store, clock: systemClock })
  return registryTools({ registry, repo: REPO, operator: 'op', via: { kind: 'session', id: 's1' } })
}

describe('registry tool schemas strip repo', () => {
  test('every registry entry produces a tool — none is dropped by the strip', () => {
    const store = new MemoryBuildStore({ clock: systemClock })
    const registry = buildRegistry({ store, clock: systemClock })
    const tools = toolsForStore()
    for (const entry of registry.entries) {
      expect(tools[entry.name]).toBeDefined()
    }
  })

  test('tickets.update survives its refinement: strips repo, keeps the update-must-name-a-field rule', () => {
    const schema = toolsForStore()['tickets.update']!.inputSchema as {
      safeParse: (input: unknown) => { success: boolean }
    }
    // The model supplies no repo — and the entry still exists (the strip
    // must not swallow refined objects).
    expect(schema.safeParse({ id: 'AUT-8', title: 'New title' }).success).toBe(true)
    // The refinement survives the safeExtend rebuild.
    expect(schema.safeParse({ id: 'AUT-8' }).success).toBe(false)
    // A supplied repo fails validation instead of silently retargeting.
    expect(schema.safeParse({ id: 'AUT-8', title: 'x', repo: REPO }).success).toBe(false)
  })

  test('builds.answer and harvest.control rebuild their unions without a required repo', () => {
    const tools = toolsForStore()
    for (const [name, valid] of [
      ['builds.answer', { slug: 'b1', resolution: 'retry' }],
      ['harvest.control', { action: 'toggle-gate' }],
    ] as const) {
      const schema = tools[name]!.inputSchema as {
        safeParse: (input: unknown) => { success: boolean }
      }
      // Some union member accepts the input without a repo…
      expect(schema.safeParse(valid).success).toBe(true)
      // …and no member accepts one: the rebuilt union strips repo from
      // every option (the original union fell through unchanged).
      expect(schema.safeParse({ ...valid, repo: REPO }).success).toBe(false)
    }
  })
})
