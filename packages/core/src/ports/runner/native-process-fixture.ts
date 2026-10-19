/** Child adapter process shared by deterministic and opt-in live resume proofs. */
import { ClaudeAgentRunner } from './claude'
import { CodexAgentRunner } from './codex'
import { PiAgentRunner } from './pi'
import { resumeAgent } from './native-session'
import type { AgentStartOpts, NativeSessionHandle } from '../types'

if (import.meta.main) {
  const input = JSON.parse(await Bun.stdin.text()) as {
    provider: string
    opts: AgentStartOpts
    handle?: NativeSessionHandle
    message?: string
  }
  const runner =
    input.provider === 'claude'
      ? new ClaudeAgentRunner()
      : input.provider === 'codex'
        ? new CodexAgentRunner()
        : new PiAgentRunner()
  let observed: NativeSessionHandle | undefined
  input.opts.onNativeSession = async (handle) => {
    observed = handle
  }
  if (input.handle === undefined) {
    const started = await runner.start(input.opts)
    await runner.end(started.session)
    if (started.result.kind !== 'completed') throw new Error(started.result.failure.message)
    if (observed === undefined) throw new Error('No native identity reported')
    // Only the serialized handle crosses back from process A.
    process.stdout.write(JSON.stringify(observed))
  } else {
    const resumed = await resumeAgent(runner, input.handle, input.message!, input.opts)
    if (resumed.kind !== 'resumed') throw new Error(resumed.message)
    const transcript = await runner.end(resumed.session)
    process.stdout.write(JSON.stringify({ result: resumed.result, handle: observed, transcript }))
  }
}
