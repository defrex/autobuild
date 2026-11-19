/**
 * The judge-only `ab` (SPEC §13.1.1). The runner bundles this entry into one
 * self-contained file and writes it into the judge's scratch launcher
 * directory, so neither the launcher's content nor its process arguments name
 * the Autobuild distribution or the repository. It implements exactly
 * `ab judge context` and `ab judge prefer`: with a remote store through a
 * write-only handle, otherwise through the preference outbox. Imports stay
 * narrow so the bundle carries no dispatcher, forge, runtime or local store.
 */
import { scopeRemoteStoreToJudgeSession } from '../store/phase-session'
import { RemoteBuildStore } from '../store/remote/client'
import { redactAccountStore, AccountRedactor } from '../store/account-redaction'
import { resolveJudgeCliEnv } from './env'
import { judgeAccountRedaction, runJudgeCommand } from './judge'

export const JUDGE_ONLY_REFUSAL =
  "a judge session may run only 'ab judge context' and 'ab judge prefer'"

export interface JudgeEntryIo {
  env: Record<string, string | undefined>
  cwd: string
  stdout: (line: string) => void
  stderr: (line: string) => void
}

/** Run one judge command from argv (without the executable). */
export async function runJudgeEntry(argv: readonly string[], io: JudgeEntryIo): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'judge') {
    io.stderr(JUDGE_ONLY_REFUSAL)
    return 2
  }
  try {
    const judgeEnv = resolveJudgeCliEnv(io.env)
    const redact = judgeAccountRedaction(io.env)
    if (judgeEnv.store === undefined)
      return await runJudgeCommand(
        rest,
        { judgeEnv, workspacePath: io.cwd, ...(redact !== undefined ? { redact } : {}) },
        io.stdout,
      )
    if (!/^https?:\/\//i.test(judgeEnv.store))
      throw new Error(
        'a judge session records a local preference through its outbox; AB_STORE names only a remote store here',
      )
    const remote = new RemoteBuildStore({
      url: judgeEnv.store,
      ...(judgeEnv.token !== undefined ? { token: judgeEnv.token } : {}),
    })
    const names = io.env.AB_ACCOUNT_CREDENTIAL_ENVS
      ? (JSON.parse(io.env.AB_ACCOUNT_CREDENTIAL_ENVS) as string[])
      : undefined
    const inner =
      names === undefined
        ? remote
        : redactAccountStore(remote, new AccountRedactor(() => names.map((name) => io.env[name])))
    const store = scopeRemoteStoreToJudgeSession(inner, {
      build: judgeEnv.build,
      panel: judgeEnv.panel,
      judge: judgeEnv.judge,
      session: judgeEnv.session,
    })
    try {
      return await runJudgeCommand(rest, { judgeEnv, store, workspacePath: io.cwd }, io.stdout)
    } finally {
      await store.close()
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main)
  process.exit(
    await runJudgeEntry(process.argv.slice(2), {
      env: process.env,
      cwd: process.cwd(),
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    }),
  )
