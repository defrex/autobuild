import { describe, expect, test } from 'bun:test'
import { KERNEL, humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { MemoryBuildStore } from '../store/memory'
import {
  DEFAULT_DISPATCH_AUTO_MERGE,
  DEFAULT_DISPATCH_INTAKE,
  reduceDispatchSettings,
} from './dispatch-settings'

const repo = 'acme/repo'
const ts = '2026-07-20T00:00:00.000Z'

function intake(seq: number, enabled: boolean): RepositoryEvent {
  return {
    repo,
    seq,
    ts,
    actor: humanActor('operator'),
    type: 'dispatcher.intake-set',
    payload: { enabled },
  }
}

function autoMerge(seq: number, enabled: boolean): RepositoryEvent {
  return {
    repo,
    seq,
    ts,
    actor: humanActor('operator'),
    type: 'dispatcher.auto-merge-default-set',
    payload: { enabled },
  }
}

function harvestPaused(seq: number): RepositoryEvent {
  return {
    repo,
    seq,
    ts,
    actor: KERNEL,
    type: 'harvest.paused',
    payload: {},
  }
}

describe('reduceDispatchSettings', () => {
  test('uses historical defaults for an empty or harvest-only journal', () => {
    const expected = {
      intake: DEFAULT_DISPATCH_INTAKE,
      defaultAutoMerge: DEFAULT_DISPATCH_AUTO_MERGE,
    }
    expect(reduceDispatchSettings([])).toEqual(expected)
    expect(reduceDispatchSettings([harvestPaused(1)])).toEqual(expected)
  })

  test('reduces the controls independently through interleaved harvest facts', () => {
    expect(
      reduceDispatchSettings([
        intake(1, false),
        harvestPaused(2),
        autoMerge(3, true),
        intake(4, true),
      ]),
    ).toEqual({ intake: true, defaultAutoMerge: true })
  })

  test('settings are isolated by repository stream', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('acme/a')
    await store.ensureRepo('acme/b')
    await store.appendRepo('acme/a', {
      actor: humanActor('operator'),
      type: 'dispatcher.intake-set',
      payload: { enabled: false },
    })
    await store.appendRepo('acme/a', {
      actor: humanActor('operator'),
      type: 'dispatcher.auto-merge-default-set',
      payload: { enabled: true },
    })

    expect(reduceDispatchSettings(await store.getRepoEvents('acme/a'))).toEqual({
      intake: false,
      defaultAutoMerge: true,
    })
    expect(reduceDispatchSettings(await store.getRepoEvents('acme/b'))).toEqual({
      intake: true,
      defaultAutoMerge: false,
    })
  })

  test('the greatest repository sequence wins even when input is stale or unordered', () => {
    expect(
      reduceDispatchSettings([
        intake(8, false),
        autoMerge(7, true),
        intake(2, true),
        autoMerge(3, false),
      ]),
    ).toEqual({ intake: false, defaultAutoMerge: true })
  })
})
