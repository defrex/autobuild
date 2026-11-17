import { describe, test } from 'bun:test'
import { optimizationLog, panelOptimizationLog } from './generators/optimization-log'
import { checkIncremental } from './incremental-contract'
import { optimizationLedgerReducer, optimizationReducer } from './optimization'
import { buildReducer } from './reducer'

describe('optimization reducers are incremental', () => {
  for (const [name, log] of [
    ['command', optimizationLog()],
    ['panel', panelOptimizationLog()],
  ] as const) {
    test(`the digest advanced in chunks equals the whole reduction (${name})`, () => {
      checkIncremental(optimizationReducer, log)
    })

    test(`the ledger advanced in chunks equals the whole reduction (${name})`, () => {
      checkIncremental(optimizationLedgerReducer, log)
    })

    test(`BuildState embeds the same digest incrementally (${name})`, () => {
      checkIncremental(buildReducer, log, { stepwise: false })
    })
  }
})
