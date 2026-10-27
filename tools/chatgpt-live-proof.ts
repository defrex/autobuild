import { CodexAgentRunner } from '../packages/core/src/ports/runner/codex'
/** Opt-in maintainer evidence. No token, provider output or guest content is printed. */
import { Sandbox } from '@vercel/sandbox'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { resolveMainRepo } from '../packages/core/src/cli/main-checkout'
import { spawnExec } from '../packages/core/src/ports/workspace/git-worktree'
import { loadConfig } from '../packages/core/src/config/load'
import { LocalCredentials } from '../packages/core/src/accounts/local-credentials'
import { LocalAccountOwner } from '../packages/core/src/accounts/local-owner'
import { accountPolicy } from '../packages/core/src/ports/workspace/account-policy'
import { accountPlaceholder } from '../packages/core/src/config/accounts'
import { vercelSdkCredentials } from '../packages/core/src/ports/workspace/vercel-sandbox'
import { credentialValues } from '../packages/core/src/accounts/chatgpt-state'

function line(name: string, pass: boolean) {
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name}\n`)
}
/** Instance methods reuse the authenticated client established by Sandbox.create,
 * including stop/delete; they do not accept separate credentials. */
export async function createProofSandbox(
  networkPolicy: NonNullable<Parameters<typeof Sandbox.create>[0]>['networkPolicy'],
  timeout: number,
  env: Record<string, string | undefined> = process.env,
  create = Sandbox.create,
) {
  return create({ ...vercelSdkCredentials(env), runtime: 'node24', timeout, networkPolicy })
}

export async function deleteProofSandbox(
  sandbox: Pick<Sandbox, 'stop' | 'delete'>,
  report = line,
): Promise<boolean> {
  let stopped = true
  try {
    await sandbox.stop()
  } catch {
    stopped = false
  }
  try {
    await sandbox.delete()
    report('sandbox-deleted', stopped)
    return stopped
  } catch {
    report('sandbox-deleted', false)
    return false
  }
}

export async function preflight() {
  let sandbox: Sandbox | undefined
  try {
    // Exercise the exact account-transform shape without any ChatGPT credential.
    const account = { kind: 'chatgpt-subscription' as const, credentialEnv: 'PROOF_ACCESS' }
    const policy = accountPolicy(
      'allow-all',
      { proof: account },
      { PROOF_ACCESS: 'preflight-inert-value' },
    ).policy
    sandbox = await createProofSandbox(policy, 60000)
    const command = await sandbox.runCommand({ cmd: 'true' })
    const pass = command.exitCode === 0
    line('sandbox-created', pass)
    if (!pass) process.exitCode = 1
  } catch {
    line('sandbox-created', false)
    process.exitCode = 1
  } finally {
    if (sandbox) {
      if (!(await deleteProofSandbox(sandbox))) process.exitCode = 1
    } else {
      line('sandbox-deleted', false)
      process.exitCode = 1
    }
  }
}
function roll(value: Uint8Array): number {
  let hash = 0
  for (const byte of value) hash = (Math.imul(hash, 257) + byte) >>> 0
  return hash
}
/** Hashes admit substring matching without ever sending a real token to the guest.
 * The rolling hash filters candidates; SHA-256 verifies every match. */
function scanScript(values: string[]): string {
  const needles = values.map((value) => ({
    length: Buffer.byteLength(value),
    roll: roll(Buffer.from(value)),
    sha: createHash('sha256').update(value).digest('hex'),
  }))
  return `
const fs = require('node:fs'), crypto = require('node:crypto');
const needles = ${JSON.stringify(needles)};
const deadline = Date.now() + 600000, max = Math.max(...needles.map(n => n.length));
let total = 0, found = false, sawCodex = false;
function scan(bytes) {
  for (const n of needles) {
    let hash=0,power=1;
    for(let j=1;j<n.length;j++) power=Math.imul(power,257)>>>0;
    for(let i=0;i<bytes.length;i++) {
      if(i>=n.length) hash=(hash-Math.imul(bytes[i-n.length],power))>>>0;
      hash=(Math.imul(hash,257)+bytes[i])>>>0;
      if(i+1>=n.length && hash===n.roll && crypto.createHash('sha256').update(bytes.subarray(i+1-n.length,i+1)).digest('hex')===n.sha) found=true;
    }
  }
}
function file(path) {
  if(Date.now()>deadline) throw Error();
  let fd; try { fd=fs.openSync(path,'r'); } catch { return; }
  try {
    let tail=Buffer.alloc(0), buf=Buffer.alloc(65536), count;
    while((count=fs.readSync(fd,buf,0,buf.length,null))>0) {
      total+=count; if(total>8*1024*1024*1024 || Date.now()>deadline) throw Error();
      const bytes=Buffer.concat([tail,buf.subarray(0,count)]);
      scan(bytes); tail=bytes.subarray(Math.max(0,bytes.length-max+1));
    }
  } finally { fs.closeSync(fd); }
}
function walk(path) {
  let entries; try { entries=fs.readdirSync(path,{withFileTypes:true}); } catch { return; }
  for(const e of entries) {
    const p=path==='/'?'/'+e.name:path+'/'+e.name;
    if(['/proc','/sys','/dev'].includes(p)) continue;
    if(e.isDirectory()) walk(p); else if(e.isFile()) file(p);
  }
}
try {
 scan(Buffer.from(JSON.stringify(process.env)));
 for(const p of fs.readdirSync('/proc')) if(/^\\d+$/.test(p)) {
   file('/proc/'+p+'/environ'); file('/proc/'+p+'/cmdline');
   try {
     const command=fs.readFileSync('/proc/'+p+'/cmdline','utf8');
     if(command.includes('codex') && command.includes('exec')) sawCodex=true;
   } catch {}

 }
 walk('/');
 process.stdout.write(found||!sawCodex?'FAIL guest-token-exclusion\\n':'PASS guest-token-exclusion\\n');
 process.exitCode=found||!sawCodex?1:0;
} catch { process.stdout.write('FAIL guest-token-exclusion\\n'); process.exitCode=1; }
`
}
async function main() {
  const name = process.argv[2]
  if (!name || process.argv.length !== 3) throw new Error('usage')
  if (name === '--preflight') return preflight()
  const root = await resolveMainRepo(process.cwd(), spawnExec)
  const config = await loadConfig(join(root, 'autobuild.toml'))
  const account = config.accounts[name]
  if (account?.kind !== 'chatgpt-subscription') throw new Error('account')
  const credentials = new LocalCredentials(join(root, '.autobuild'))
  const owner = new LocalAccountOwner(credentials)
  owner.claim(name)
  let sandbox: Sandbox | undefined
  const deadline = Date.now() + 75 * 60000
  try {
    const record = credentials.load(name)!
    if (record.status !== 'ready' || record.state.expiresAt <= Date.now())
      throw new Error('credential')
    let state = record.state
    const tokens = credentialValues(state)
    const local = async (label: string) => {
      try {
        await new CodexAgentRunner().complete({
          cwd: root,
          env: {},
          account: { name, descriptor: account },
          prompt: 'Reply only OK.',
          signal: AbortSignal.timeout(60000),
        })
        line(label, true)
      } catch {
        line(label, false)
        throw new Error('local inference')
      }
    }
    await local('local-codex-before-refresh')
    const policy = () =>
      accountPolicy(
        'allow-all',
        { [name]: account },
        { [account.credentialEnv]: state.accessToken },
      ).policy
    sandbox = await createProofSandbox(policy(), 75 * 60000)
    line('sandbox-created', true)
    const install = await sandbox.runCommand({
      cmd: 'npm',
      args: ['install', '--prefix', '/vercel/sandbox/codex', '@openai/codex'],
    })
    if (install.exitCode !== 0) throw new Error('installation')
    const provider = 'model_providers.autobuild_chatgpt.'
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'model_provider="autobuild_chatgpt"',
      ...Object.entries({
        name: 'ChatGPT plan',
        base_url: 'https://api.openai.com/v1',
        env_key: 'AUTOBUILD_CHATGPT_BEARER',
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
      }).flatMap(([k, v]) => ['-c', `${provider}${k}=${JSON.stringify(v)}`]),
      '-c',
      'web_search="disabled"',
      '--skip-git-repo-check',
      '--',
      'Run exactly this shell command: touch /vercel/sandbox/model-started; while [ ! -f /vercel/sandbox/refresh-ready ]; do sleep 1; done. After it finishes, reply only OK.',
    ]
    const inference = async (label: string, during?: () => Promise<void>) => {
      const command = await sandbox!.runCommand({
        detached: true,
        cmd: '/vercel/sandbox/codex/node_modules/.bin/codex',
        args,
        env: {
          HOME: '/vercel/sandbox/proof-home',
          CODEX_HOME: '/vercel/sandbox/proof-home',
          AUTOBUILD_CHATGPT_BEARER: accountPlaceholder(name),
        },
      })
      await during?.()
      const result = await command.wait()
      const output = await result.stdout()
      const events = output
        .split('\n')
        .filter(Boolean)
        .map((s) => {
          try {
            return JSON.parse(s)
          } catch {
            return {}
          }
        })
      const pass =
        result.exitCode === 0 &&
        events.some((e) => e.type === 'turn.completed') &&
        events.some(
          (e) =>
            e.type === 'item.completed' &&
            e.item?.type === 'command_execution' &&
            String(e.item.command).includes('refresh-ready') &&
            e.item.exit_code === 0,
        ) &&
        !events.some((e) => e.type === 'turn.failed' || e.type === 'error')
      line(label, pass)
      if (!pass) throw new Error('inference')
    }
    await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', '/vercel/sandbox/proof-home'] })
    const scan = async () => {
      await sandbox!.writeFiles([
        { path: '/vercel/sandbox/token-exclusion.cjs', content: Buffer.from(scanScript(tokens)) },
      ])
      const result = await sandbox!.runCommand({
        cmd: 'node',
        args: ['/vercel/sandbox/token-exclusion.cjs'],
      })
      const pass =
        result.exitCode === 0 && (await result.stdout()).trim() === 'PASS guest-token-exclusion'
      line('guest-token-exclusion', pass)
      if (!pass) throw new Error('exclusion')
    }
    await inference('codex-after-refresh', async () => {
      const startedUntil = Math.min(deadline, Date.now() + 120000)
      let started = false
      while (Date.now() < startedUntil) {
        const check = await sandbox!.runCommand({
          cmd: 'test',
          args: ['-f', '/vercel/sandbox/model-started'],
        })
        if (check.exitCode === 0) {
          started = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      line('codex-before-refresh', started)
      if (!started) throw new Error('tool startup')
      await scan()
      const due = state.earliestRefreshAt ?? Date.now()
      if (due > deadline - 12 * 60000) {
        line('real-provider-refresh', false)
        throw new Error('window')
      }
      while (Date.now() < due)
        await new Promise((resolve) => setTimeout(resolve, Math.min(30000, due - Date.now())))
      try {
        await owner.tick({ [name]: account }, Math.max(Date.now(), state.expiresAt - 50000))
        const next = credentials.load(name)!
        if (
          next.state.refreshToken === state.refreshToken ||
          next.state.accessToken === state.accessToken
        )
          throw new Error('rotation')
        state = next.state
        tokens.push(...credentialValues(state))
        line('real-provider-refresh', true)
      } catch {
        line('real-provider-refresh', false)
        throw new Error('refresh')
      }
      await sandbox!.update({ networkPolicy: policy() })
      await local('local-codex-after-refresh')
      await scan()
      await sandbox!.writeFiles([
        { path: '/vercel/sandbox/refresh-ready', content: Buffer.from('ready') },
      ])
    })
  } finally {
    if (sandbox && !(await deleteProofSandbox(sandbox))) process.exitCode = 1
    owner.release(name)
  }
}
if (import.meta.main)
  await main().catch(() => {
    line('live-proof', false)
    process.exitCode = 1
  })
