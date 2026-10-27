import { sensitiveAccountValues } from '../../accounts/sensitive'
import { LocalCredentials } from '../../accounts/local-credentials'
import { localInference } from '../../accounts/local-inference'
import { resolveMainRepo } from '../../cli/main-checkout'
import { spawnExec } from '../workspace/git-worktree'
import { mkdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { SelectedAccount } from '../../config/accounts'
import { accountPlaceholder } from '../../config/accounts'

/** A selected account owns provider routing even when callers supply config flags. */
export async function chatgptProvider(
  account: SelectedAccount | undefined,
  env: Record<string, string>,
  cwd: string,
): Promise<{ env: Record<string, string>; args: string[]; close: () => Promise<void> }> {
  if (account?.descriptor.kind !== 'chatgpt-subscription')
    return { env, args: [], close: async () => {} }
  const originalCredential = env[account.descriptor.credentialEnv]
  if (originalCredential && originalCredential !== accountPlaceholder(account.name))
    sensitiveAccountValues.add(originalCredential)
  const selected = { ...env }
  for (const key of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT_ID',
    'CODEX_API_KEY',
    account.descriptor.credentialEnv,
  ])
    delete selected[key]
  const scratch = join(cwd, '.ab')
  mkdirSync(scratch, { recursive: true, mode: 0o700 })
  const scratchInfo = lstatSync(scratch)
  if (!scratchInfo.isDirectory() || scratchInfo.isSymbolicLink())
    throw new Error('Unsafe isolated Codex state directory')
  const home = join(scratch, 'codex-chatgpt')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const homeInfo = lstatSync(home)
  if (
    !homeInfo.isDirectory() ||
    homeInfo.isSymbolicLink() ||
    (homeInfo.mode & 0o777) !== 0o700 ||
    homeInfo.uid !== process.getuid?.()
  )
    throw new Error('Unsafe isolated Codex state directory')
  const remote = env.AB_ACCOUNT_PLACEHOLDERS === '1'
  const transport = remote
    ? undefined
    : localInference(
        new LocalCredentials(join(await resolveMainRepo(cwd, spawnExec), '.autobuild')),
        account.name,
      )
  const base = remote ? 'https://api.openai.com/v1' : transport!.baseUrl
  const credential = remote ? accountPlaceholder(account.name) : transport!.capability
  if (!base || !credential || (!remote && !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(base)))
    throw new Error(
      `ChatGPT account ${JSON.stringify(account.name)} requires its dispatcher inference transport; sign in again`,
    )
  for (const [key, value] of Object.entries(selected))
    if ([...sensitiveAccountValues].some((secret) => value.includes(secret))) delete selected[key]
  selected.HOME = home
  selected.CODEX_HOME = home
  selected.AUTOBUILD_CHATGPT_BEARER = credential
  const provider = 'model_providers.autobuild_chatgpt.'
  const settings: Record<string, string | boolean> = {
    model_provider: 'autobuild_chatgpt',
    [`${provider}name`]: 'ChatGPT plan',
    [`${provider}base_url`]: base,
    [`${provider}env_key`]: 'AUTOBUILD_CHATGPT_BEARER',
    [`${provider}wire_api`]: 'responses',
    [`${provider}requires_openai_auth`]: false,
    [`${provider}supports_websockets`]: false,
  }
  return {
    env: selected,
    close: async () => {
      await transport?.close()
    },
    args: [
      '--ignore-user-config',
      ...Object.entries(settings).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`]),
    ],
  }
}
