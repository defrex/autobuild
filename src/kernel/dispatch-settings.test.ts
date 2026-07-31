import { describe, expect, test } from 'bun:test'
import { KERNEL, humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { MemoryBuildStore } from '../store/memory'
import {
  DEFAULT_DISPATCH_AUTO_MERGE,
  DEFAULT_DISPATCH_INTAKE,
  DEFAULT_DISPATCH_PAUSED,
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

function pause(seq: number, enabled: boolean): RepositoryEvent {
  return {
    repo,
    seq,
    ts,
    actor: humanActor('operator'),
    type: 'dispatcher.pause-set',
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
      paused: DEFAULT_DISPATCH_PAUSED,
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
        pause(4, true),
        intake(5, true),
      ]),
    ).toEqual({ intake: true, paused: true, defaultAutoMerge: true })
  })

  test('the repository pause is independent of intake in both directions', () => {
    // The spec's settled product decision: intake off alone never holds queued
    // work, and a pause never turns intake off by itself.
    expect(reduceDispatchSettings([intake(1, false)])).toEqual({
      intake: false,
      paused: false,
      defaultAutoMerge: false,
    })
    expect(reduceDispatchSettings([pause(1, true)])).toEqual({
      intake: true,
      paused: true,
      defaultAutoMerge: false,
    })
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
    await store.appendRepo('acme/a', {
      actor: humanActor('operator'),
      type: 'dispatcher.pause-set',
      payload: { enabled: true },
    })

    expect(reduceDispatchSettings(await store.getRepoEvents('acme/a'))).toEqual({
      intake: false,
      paused: true,
      defaultAutoMerge: true,
    })
    expect(reduceDispatchSettings(await store.getRepoEvents('acme/b'))).toEqual({
      intake: true,
      paused: false,
      defaultAutoMerge: false,
    })
  })

  test('the greatest repository sequence wins even when input is stale or unordered', () => {
    expect(
      reduceDispatchSettings([
        intake(8, false),
        autoMerge(7, true),
        pause(6, true),
        intake(2, true),
        autoMerge(3, false),
        pause(1, false),
      ]),
    ).toEqual({ intake: false, paused: true, defaultAutoMerge: true })
  })
})
