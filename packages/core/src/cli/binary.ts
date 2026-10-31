import { selectDispatchMode } from './dispatch-mode'
import { spawnExec } from '../ports/workspace/git-worktree'
import { join } from 'node:path'
import type { DashboardRendererResolver } from './dashboard/render'
import { loadDotEnv } from './dotenv'
import { parseDispatchArgs } from './dispatch-args'
import { launchDispatcher } from './dispatch-launcher'
import { DISPATCH_GENERATION_ENV, DISPATCH_CONDITIONAL_ENV } from './dispatch-launch-contract'
export {
  usesGenericSessionlessSigintHandler,
  installSessionlessSigintHandler,
  withDispatchTerminalRestore,
} from './binary-lifecycle'
export async function runBinary(
  argv: string[],
  resolver?: DashboardRendererResolver,
): Promise<number> {
  delete process.env.AB_DISPATCH_LAUNCH_CONTEXT
  delete process.env[DISPATCH_GENERATION_ENV]
  delete process.env[DISPATCH_CONDITIONAL_ENV]
  if (argv[0] !== '--version') loadDotEnv(join(process.cwd(), '.env'), process.env)
  delete process.env.AB_DISPATCH_LAUNCH_CONTEXT
  delete process.env[DISPATCH_GENERATION_ENV]
  delete process.env[DISPATCH_CONDITIONAL_ENV]
  if (
    argv[0] === 'dispatch' &&
    !(argv.length === 2 && argv[1] === '--help') &&
    resolver === undefined
  ) {
    try {
      const args = parseDispatchArgs(argv.slice(1), process.env)
      if (!args.viewer && !args.once && !args.repository) {
        const mode = await selectDispatchMode({
          ...args,
          targetRepo: process.cwd(),
          env: process.env,
          exec: spawnExec,
          stderr: console.error,
        })
        if (!mode.viewer) return await launchDispatcher(argv)
        const { runDirectBinary } = await import('./binary-direct')
        return runDirectBinary(
          [...argv, '--viewer', '--dispatched-by', mode.dispatchedBy!],
          resolver,
        )
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  }
  const { runDirectBinary } = await import('./binary-direct')
  return runDirectBinary(argv, resolver)
}
