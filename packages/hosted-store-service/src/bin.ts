#!/usr/bin/env bun
import { mintToken } from 'autobuild/remote-store'

const USAGE = `Usage:
  ab-hosted-store mint operator (--ttl-seconds N | --expires-at ISO-8601)
  ab-hosted-store mint admin (--ttl-seconds N | --expires-at ISO-8601)
  ab-hosted-store mint build --build SLUG --session SESSION (--ttl-seconds N | --expires-at ISO-8601)`

type Env = Record<string, string | undefined>

function option(args: string[], name: string): string | undefined {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []))
  if (indexes.length > 1) throw new Error(`${name} may only be supplied once`)
  const index = indexes[0]
  if (index === undefined) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function expiry(args: string[], now: Date): number {
  const ttl = option(args, '--ttl-seconds')
  const expiresAt = option(args, '--expires-at')
  if ((ttl === undefined) === (expiresAt === undefined)) {
    throw new Error('supply exactly one of --ttl-seconds or --expires-at')
  }
  let exp: number
  if (ttl !== undefined) {
    if (!/^\d+$/.test(ttl) || Number(ttl) <= 0) {
      throw new Error('--ttl-seconds must be a positive integer')
    }
    exp = now.getTime() + Number(ttl) * 1000
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt!)) {
      throw new Error('--expires-at must be an ISO-8601 UTC instant')
    }
    exp = Date.parse(expiresAt!)
  }
  if (!Number.isFinite(exp) || exp <= now.getTime()) {
    throw new Error('token expiry must be a valid future instant')
  }
  return exp
}

export function mintTokenFromArgs(args: string[], env: Env, now = new Date()): string {
  if (
    args[0] !== 'mint' ||
    (args[1] !== 'operator' && args[1] !== 'admin' && args[1] !== 'build')
  ) {
    throw new Error('expected "mint operator", "mint admin", or "mint build"')
  }
  const secret = env.AB_STORE_SECRET?.trim()
  if (!secret) throw new Error('AB_STORE_SECRET is required and must be nonblank')
  const exp = expiry(args, now)
  const allowed = new Set([
    'mint',
    args[1],
    '--ttl-seconds',
    option(args, '--ttl-seconds'),
    '--expires-at',
    option(args, '--expires-at'),
  ])
  if (args[1] === 'operator' || args[1] === 'admin') {
    for (const arg of args) if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`)
    return args[1] === 'operator'
      ? mintToken(secret, { operator: true, session: '*', exp })
      : mintToken(secret, { build: '*', session: '*', exp })
  }
  const build = option(args, '--build')?.trim()
  const session = option(args, '--session')?.trim()
  if (!build) throw new Error('--build is required and must be nonblank')
  if (!session) throw new Error('--session is required and must be nonblank')
  allowed
    .add('--build')
    .add(option(args, '--build'))
    .add('--session')
    .add(option(args, '--session'))
  for (const arg of args) if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`)
  return mintToken(secret, { build, session, exp })
}

export function runTokenCli(
  args = process.argv.slice(2),
  env: Env = process.env,
  write: (text: string) => void = (text) => console.log(text),
  writeError: (text: string) => void = (text) => console.error(text),
): number {
  try {
    write(mintTokenFromArgs(args, env))
    return 0
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    return 2
  }
}

if (import.meta.main) process.exitCode = runTokenCli()
