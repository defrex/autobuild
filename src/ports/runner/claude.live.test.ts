import { describe, test } from 'bun:test'
import { ClaudeAgentRunner } from './claude'
import { runLiveAgentRunnerContract } from './live-contract-fixture'

const enabled = process.env.AB_RUN_LIVE_PORT_CONTRACTS === '1'

function requiredModel(): string {
  const value = process.env.AB_CLAUDE_CONTRACT_MODEL?.trim()
  if (!value) {
    throw new Error(
      'Claude live AgentRunner contract requires AB_CLAUDE_CONTRACT_MODEL when AB_RUN_LIVE_PORT_CONTRACTS=1',
    )
  }
  return value
}

describe.skipIf(!enabled)('Claude live AgentRunner contract (opt-in)', () => {
  test('runs start, continue, end, ambient/PATH probe, and one-shot against the real Claude Code CLI', async () => {
    await runLiveAgentRunnerContract(new ClaudeAgentRunner(), requiredModel())
  }, 300_000)
})
