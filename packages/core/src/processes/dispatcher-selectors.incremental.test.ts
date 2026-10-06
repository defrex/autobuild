import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import {
  buildLog,
  checkAgainstReference,
  generatedLogs,
  randomBuildItem,
} from '../kernel/incremental-fixtures'
import {
  baseBranchReducer,
  openBuildWorkspaceReducer,
  provisionMarkerReducer,
  recoveryCheckpointReducer,
} from './dispatcher-selectors'

const logs = generatedLogs(buildLog, randomBuildItem)

describe('dispatcher selector reducers', () => {
  test('open workspace matches the original', () => {
    checkAgainstReference(openBuildWorkspaceReducer, logs, (events: readonly AbEvent[]) => {
      let open: unknown = null
      for (const event of events) {
        if (event.type === 'workspace.provisioned') open = event.payload
        else if (event.type === 'workspace.released') open = null
      }
      return open as never
    })
  })

  test('base branch is the first build.created in array order', () => {
    checkAgainstReference(baseBranchReducer, logs, (events: readonly AbEvent[]) => {
      for (const event of events) {
        if (event.type === 'build.created') return event.payload.baseBranch
      }
      return undefined
    })
  })

  test('provision marker matches the original', () => {
    checkAgainstReference(provisionMarkerReducer, logs, (events: readonly AbEvent[]) => {
      let marker: unknown
      for (const event of events) {
        if (event.type === 'workspace.provision-started') {
          marker = { ...event.payload, ts: event.ts, seq: event.seq }
        } else if (
          marker !== undefined &&
          (event.type === 'workspace.provisioned' || event.type === 'workspace.released')
        ) {
          marker = undefined
        }
      }
      return marker as never
    })
  })

  test('recovery checkpoint matches the original', () => {
    checkAgainstReference(recoveryCheckpointReducer, logs, (events: readonly AbEvent[]) => {
      let settled: string | undefined
      let original: string | undefined
      for (const event of events) {
        if (event.type === 'workspace.provisioned' && original === undefined) {
          original = event.payload.base.sha
        } else if (event.type === 'implement.completed') {
          settled = event.payload.commits.head
        } else if (event.type === 'reconcile.completed') {
          settled = event.payload.mergeCommit
        } else if (
          event.type === 'finalize.step-completed' &&
          event.payload.ok &&
          event.payload.headSha !== undefined
        ) {
          settled = event.payload.headSha
        }
      }
      return settled ?? original
    })
    expect(recoveryCheckpointReducer.reduce([])).toBeUndefined()
  })
})
