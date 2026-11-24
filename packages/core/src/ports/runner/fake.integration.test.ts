import {
  CONTRACT_EXHAUSTION_FAILURE,
  CONTRACT_PERMANENT_FAILURE,
  CONTRACT_RETRYABLE_FAILURE,
  describeAgentRunnerContract,
  type AgentRunnerContractFactory,
} from './contract'
import { ScriptedAgentRunner, defaultTurnResult, failedTurnResult } from './fake'

function waitForContractAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal === undefined) return reject(new Error('contract turn received no AbortSignal'))
    const abort = () => reject(signal.reason ?? new Error('contract turn aborted'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

const scriptedContractFactory: AgentRunnerContractFactory = (scenario) => {
  const turns: Array<{ message?: string; env: Record<string, string> }> = []
  const runner = new ScriptedAgentRunner({
    script: (ctx) => {
      turns.push({
        ...(ctx.message !== undefined ? { message: ctx.message } : {}),
        env: ctx.opts.env,
      })
      if (
        scenario === 'cancel-start' ||
        (scenario === 'cancel-continue' && ctx.message !== undefined)
      ) {
        return waitForContractAbort(ctx.opts.signal)
      }
      if (scenario === 'retryable-failure') {
        return failedTurnResult(CONTRACT_RETRYABLE_FAILURE, false)
      }
      if (scenario === 'permanent-failure') {
        return failedTurnResult(CONTRACT_PERMANENT_FAILURE, true, '', 'credentials')
      }
      if (scenario === 'exhaustion-failure') {
        return failedTurnResult(CONTRACT_EXHAUSTION_FAILURE, true, '', 'exhaustion')
      }
      return defaultTurnResult(`contract turn ${ctx.turn}`)
    },
  })
  return {
    runner,
    model: 'contract/scripted-model',
    workspacePath: process.cwd(),
    turns: () => turns,
  }
}

describeAgentRunnerContract('ScriptedAgentRunner', scriptedContractFactory)
