import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  accountRemedy,
  accountPlaceholder,
  kimiEndpoint,
  type SelectedAccount,
} from '../../config/accounts'

const ROUTING_KEYS = [
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

/** Existing environment-owned launch metadata also covers a runner that
 * started before its first account was declared by a live configuration reload. */
function usesPlaceholders(env: Readonly<Record<string, string>>): boolean {
  if (env.AB_ACCOUNT_PLACEHOLDERS === '1') return true
  return [env.AB_BUILD_RUNNER_OPTIONS, env.AB_HARVEST_RUNNER_OPTIONS].some((raw) => {
    if (!raw) return false
    try {
      const launch = JSON.parse(raw) as { supervision?: { kind?: unknown } } | null
      return launch?.supervision?.kind === 'environment'
    } catch {
      return false
    }
  })
}

/** Apply after ambient merging. Inputs and process.env remain untouched. */
export function accountEnvironment(
  ambient: Readonly<Record<string, string>>,
  account?: SelectedAccount,
  model?: string,
): Record<string, string> {
  if (account === undefined) return { ...ambient }
  const env = { ...ambient }
  const remote = usesPlaceholders(env)
  const originalCredential = env[account.descriptor.credentialEnv]
  const credential = remote ? accountPlaceholder(account.name) : originalCredential
  if (remote && originalCredential)
    for (const [key, value] of Object.entries(env))
      if (value.includes(originalCredential)) delete env[key]
  for (const key of ROUTING_KEYS) delete env[key]
  if (remote && !ROUTING_KEYS.some((key) => key === account.descriptor.credentialEnv))
    env[account.descriptor.credentialEnv] = credential!
  if (account.descriptor.kind === 'kimi-code') {
    if (!credential) throw new Error(`Missing credential: ${accountRemedy(account)}`)
    const selectedModel = model ?? 'kimi-for-coding'
    Object.assign(env, {
      ANTHROPIC_API_KEY: credential,
      ANTHROPIC_BASE_URL: kimiEndpoint(account.descriptor.region).baseUrl,
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_FABLE_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: selectedModel,
      CLAUDE_CODE_SUBAGENT_MODEL: selectedModel,
    })
  } else if (credential) env.CLAUDE_CODE_OAUTH_TOKEN = credential
  else if (env.AB_WORKSPACE_PROVIDER === 'vercel-sandbox')
    throw new Error(`Missing credential: ${accountRemedy(account)}`)
  return env
}

/** CLI settings outrank user/project settings.env. Empty competing values also
 * override saved values, without editing the user's files. */
export async function withAccountSettings<T>(
  env: Record<string, string>,
  account: SelectedAccount | undefined,
  invoke: (args: string[]) => Promise<T>,
  files: {
    mkdtemp: (prefix: string) => Promise<string>
    writeFile: typeof writeFile
    rm: typeof rm
  } = { mkdtemp, writeFile, rm },
): Promise<T> {
  if (account === undefined) return await invoke([])
  let directory: string | undefined
  try {
    // mkdtemp creates the directory with mode 0700 from the outset.
    directory = await files.mkdtemp(join(resolve(tmpdir()), 'autobuild-account-'))
    const path = join(directory, 'settings.json')
    await files.writeFile(
      path,
      JSON.stringify({
        apiKeyHelper: '',
        env: Object.fromEntries(ROUTING_KEYS.map((key) => [key, env[key] ?? ''])),
      }),
      { flag: 'wx', mode: 0o600 },
    )
  } catch {
    if (directory !== undefined) {
      try {
        await files.rm(directory, { recursive: true, force: true })
      } catch {
        throw new Error('Account settings setup and cleanup failed')
      }
    }
    throw new Error('Account settings setup failed')
  }
  let outcome: { value: T } | { error: unknown }
  let cleanupFailed = false
  try {
    outcome = { value: await invoke(['--settings', join(directory, 'settings.json')]) }
  } catch (error) {
    outcome = { error }
  } finally {
    try {
      await files.rm(directory, { recursive: true, force: true })
    } catch {
      cleanupFailed = true
    }
  }
  if (cleanupFailed) {
    throw new Error(
      'error' in outcome
        ? 'Account invocation failed and settings cleanup failed'
        : 'Account settings cleanup failed',
      'error' in outcome ? { cause: outcome.error } : undefined,
    )
  }
  if ('error' in outcome) throw outcome.error
  return outcome.value
}
