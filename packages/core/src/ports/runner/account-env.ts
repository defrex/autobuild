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

/** Apply after ambient merging. Inputs and process.env remain untouched. */
export function accountEnvironment(
  ambient: Readonly<Record<string, string>>,
  account?: SelectedAccount,
  model?: string,
): Record<string, string> {
  if (account === undefined) return { ...ambient }
  const env = { ...ambient }
  const credential =
    env.AB_ACCOUNT_PLACEHOLDERS === '1'
      ? accountPlaceholder(account.name)
      : env[account.descriptor.credentialEnv]
  for (const key of ROUTING_KEYS) delete env[key]
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
export function accountSettings(env: Record<string, string>, account?: SelectedAccount): string[] {
  if (account === undefined) return []
  return [
    '--settings',
    JSON.stringify({
      apiKeyHelper: '',
      env: Object.fromEntries(ROUTING_KEYS.map((key) => [key, env[key] ?? ''])),
    }),
  ]
}
