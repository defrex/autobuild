import { describe, test } from 'bun:test'
import { AntigravityAgentRunner } from './antigravity'
import { runLiveAgentRunnerContract, runLiveNativeResumeContract } from './live-contract-fixture'

const enabled = process.env.AB_RUN_LIVE_PORT_CONTRACTS === '1'

function requiredModel(): string {
  const value = process.env.AB_ANTIGRAVITY_CONTRACT_MODEL?.trim()
  if (!value) {
    throw new Error(
      'Antigravity live AgentRunner contract requires AB_ANTIGRAVITY_CONTRACT_MODEL when AB_RUN_LIVE_PORT_CONTRACTS=1',
    )
  }
  return value
}

// Also the maintainer's evidence for agy behavior the offline suite cannot
// prove: `/skill` expansion in print mode, the managed `ab` reaching tool
// commands, and the missing-conversation diagnostic on resume.
describe.skipIf(!enabled)('Antigravity live AgentRunner contract (opt-in)', () => {
  test('runs start, continue, end, and the ambient/PATH probe against the real agy CLI', async () => {
    // Antigravity declares no one-shot capability, so that block is skipped.
    await runLiveAgentRunnerContract(new AntigravityAgentRunner(), requiredModel())
  }, 300_000)
  test('resumes a recorded handle in a separate process with native memory', async () => {
    await runLiveNativeResumeContract('antigravity', requiredModel())
  }, 300_000)
})
