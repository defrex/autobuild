import { describe, test } from 'bun:test'
import { runLiveAgentRunnerContract } from './live-contract-fixture'
import { PiAgentRunner } from './pi'

const enabled = process.env.AB_RUN_LIVE_PORT_CONTRACTS === '1'

function requiredModel(): string {
  const value = process.env.AB_PI_CONTRACT_MODEL?.trim()
  if (!value) {
    throw new Error(
      'Pi live AgentRunner contract requires AB_PI_CONTRACT_MODEL when AB_RUN_LIVE_PORT_CONTRACTS=1',
    )
  }
  return value
}

describe.skipIf(!enabled)('Pi live AgentRunner contract (opt-in)', () => {
  test(
    'runs start, continue, end, ambient/PATH probe, and one-shot against the real SDK',
    async () => {
      await runLiveAgentRunnerContract(new PiAgentRunner(), requiredModel())
    },
    300_000,
  )
})
