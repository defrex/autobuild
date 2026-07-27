import { describe, test } from 'bun:test'
import { CodexAgentRunner } from './codex'
import { runLiveAgentRunnerContract } from './live-contract-fixture'

const enabled = process.env.AB_RUN_LIVE_PORT_CONTRACTS === '1'

function requiredModel(): string {
  const value = process.env.AB_CODEX_CONTRACT_MODEL?.trim()
  if (!value) {
    throw new Error(
      'Codex live AgentRunner contract requires AB_CODEX_CONTRACT_MODEL when AB_RUN_LIVE_PORT_CONTRACTS=1',
    )
  }
  return value
}

describe.skipIf(!enabled)('Codex live AgentRunner contract (opt-in)', () => {
  test('runs start, continue, end, ambient/PATH probe, and one-shot against the real Codex CLI', async () => {
    await runLiveAgentRunnerContract(new CodexAgentRunner(), requiredModel())
  }, 300_000)
})
