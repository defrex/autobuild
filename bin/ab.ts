#!/usr/bin/env bun
/**
 * The `ab` binary — thin wiring only (SPEC §8). Every behavior lives in
 * src/cli/ behind injected deps; this file resolves the real ones: ambient
 * auth from the environment (D8), the store from AB_STORE (local path or
 * http(s) URL), the GitHub forge, real exec, wall clock, random ids.
 */
import { join } from 'node:path'
import { runCli, SESSIONLESS_COMMANDS } from '../src/cli/main'
import { loadDotEnv } from '../src/cli/dotenv'
import { resolveCliEnv } from '../src/cli/env'
import { resolveStore } from '../src/cli/store-ref'
import { processTerminal } from '../src/cli/terminal'
import { RemoteBuildStore } from '../src/store/remote/client'
import { GitHubForge } from '../src/ports/forge/github'
import { spawnExec } from '../src/ports/workspace/git-worktree'
import { randomIds } from '../src/ids'
import { systemClock } from '../src/store/types'

async function main(): Promise<number> {
  // Local .env supplies developer-set secrets (e.g. LINEAR_API_KEY); real
  // environment variables always win over .env values.
  loadDotEnv(join(process.cwd(), '.env'), process.env)

  const argv = process.argv.slice(2)
  const command = argv[0]

  // Sessionless commands take a repo path, not a build, so they must work with
  // no AB_* environment set. The list lives in src/cli/main.ts beside the
  // switch that implements them (SESSIONLESS_COMMANDS) — this file only routes
  // on it.
  if (command === undefined || SESSIONLESS_COMMANDS.has(command)) {
    // The dispatch watch loop runs until SIGINT; abort the signal so it exits
    // cleanly at the next tick boundary (§15.6-C: in-flight leases expire and
    // a future dispatch re-attaches).
    const controller = new AbortController()
    const onSigint = (): void => controller.abort()
    process.once('SIGINT', onSigint)
    try {
      return await runCli(argv, {
        workspacePath: process.cwd(),
        exec: spawnExec,
        processEnv: process.env,
        signal: controller.signal,
        // `ab dispatch`'s dashboard seam: interactive iff stdout is a real
        // TTY, so a pipe or redirect silently gets plain output.
        terminal: processTerminal(process.stdout),
        stdout: (line) => console.log(line),
        stderr: (line) => console.error(line),
      })
    } finally {
      process.removeListener('SIGINT', onSigint)
    }
  }

  let cliEnv
  try {
    cliEnv = resolveCliEnv(process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  const store = resolveStore(cliEnv.store, {
    token: cliEnv.token,
    remoteFactory: (url, token) => new RemoteBuildStore({ url, token }),
  })

  try {
    return await runCli(argv, {
      store,
      env: cliEnv,
      workspacePath: process.cwd(),
      forge: new GitHubForge(),
      exec: spawnExec,
      ids: randomIds(),
      clock: systemClock,
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    })
  } finally {
    await store.close()
  }
}

process.exit(await main())
