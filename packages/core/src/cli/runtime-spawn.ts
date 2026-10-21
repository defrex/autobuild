import { distributionRoot } from '../distribution'
import { ownCachedRuntime } from './dispatch-runtime-use'
/** Every cached Bun entry pins compiler resolution before evaluating any JS. */
export function bunRuntimeArguments(entry: string, args: string[] = []): string[] {
  const root = distributionRoot()
  return ownCachedRuntime(root)
    ? [
        process.execPath,
        '--no-install',
        '--tsconfig-override',
        `${root}/tsconfig.json`,
        entry,
        ...args,
      ]
    : [process.execPath, entry, ...args]
}
