#!/usr/bin/env bun
import {
  openTicketAssignmentsFromEnv,
  type TicketAssignments,
} from '@defrex/autobuild-postgres-store'
import {
  openPostgresCredentialStoreFromEnv,
  type CredentialStore,
} from '@defrex/autobuild-postgres-store/credentials'
import {
  openPostgresProjectRegistryForRecoveryFromEnv,
  normalizeProjectRepository,
  type ProjectRegistry,
} from '@defrex/autobuild-postgres-store/projects'
import { mintToken } from '@defrex/autobuild/remote-store'

const USAGE = `Usage:
  ab-hosted-store credentials issue REPOSITORY --user IDENTITY [--ttl-seconds N | --expires-at ISO-8601]
  ab-hosted-store credentials list REPOSITORY
  ab-hosted-store credentials revoke REPOSITORY --id ID --user IDENTITY
  ab-hosted-store tickets assign-team TEAM REPOSITORY --user IDENTITY
  ab-hosted-store projects list
  ab-hosted-store projects add REPOSITORY --user IDENTITY
  ab-hosted-store projects remove REPOSITORY --user IDENTITY

projects remove unregisters access only; all project data is retained.
Delete a project from the web Projects page to permanently remove its hosted data.

  ab-hosted-store mint admin (--ttl-seconds N | --expires-at ISO-8601)`

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
  if (args[1] !== 'admin')
    throw new Error('credential format changed; use credentials issue REPOSITORY --user IDENTITY')
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
  if (args[1] === 'admin') {
    for (const arg of args) if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`)
    return mintToken(secret, { version: 1, ownerAdmin: { user: 'owner:break-glass' }, exp })
  }
  throw new Error('credential format changed; use credentials issue REPOSITORY --user IDENTITY')
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

export async function runHostedCli(
  args = process.argv.slice(2),
  env: Env = process.env,
  write: (text: string) => void = console.log,
  writeError: (text: string) => void = console.error,
  open: (env: Env) => Promise<ProjectRegistry> = openPostgresProjectRegistryForRecoveryFromEnv,
  openCredentials: (env: Env) => Promise<CredentialStore> = openPostgresCredentialStoreFromEnv,
  openAssignments: (env: Env) => Promise<TicketAssignments> = openTicketAssignmentsFromEnv,
): Promise<number> {
  if (args[0] === 'tickets') {
    let assignments: TicketAssignments | undefined
    try {
      if (
        args.length !== 6 ||
        args[1] !== 'assign-team' ||
        !args[2]?.trim() ||
        args[4] !== '--user' ||
        !args[5]?.trim() ||
        args[5].startsWith('--')
      )
        throw new Error('expected tickets assign-team TEAM REPOSITORY --user IDENTITY')
      const repo = normalizeProjectRepository(args[3]!)
      assignments = await openAssignments(env)
      await assignments.assign(args[2], repo, args[5])
      write(JSON.stringify({ team: args[2], repo, assigned: true }))
      return 0
    } catch (error) {
      writeError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
      return 2
    } finally {
      await assignments?.close()
    }
  }
  if (args[0] === 'credentials') {
    let credentials: CredentialStore | undefined
    let credentialResult = 0
    try {
      const command = args[1]
      if (!['issue', 'list', 'revoke'].includes(command ?? '') || !args[2])
        throw new Error('expected credentials issue/list/revoke REPOSITORY')
      const repo = normalizeProjectRepository(args[2])
      const names =
        command === 'issue'
          ? ['--user', '--ttl-seconds', '--expires-at']
          : command === 'revoke'
            ? ['--user', '--id']
            : []
      for (let index = 3; index < args.length; index += 2) {
        if (!names.includes(args[index]!)) throw new Error(`unknown argument: ${args[index]}`)
        option(args, args[index]!)
      }
      const user = option(args, '--user')?.trim()
      if (command !== 'list' && !user) throw new Error('--user is required and must be nonblank')
      const exp =
        command === 'issue' && (args.includes('--ttl-seconds') || args.includes('--expires-at'))
          ? new Date(expiry(args, new Date()))
          : undefined
      const id = option(args, '--id')
      if (command === 'revoke' && !id) throw new Error('--id is required')
      credentials = await openCredentials(env)
      if (command === 'issue')
        write(JSON.stringify(await credentials.issue(repo, user!, exp ? { expiresAt: exp } : {})))
      else if (command === 'list') write(JSON.stringify(await credentials.list(repo)))
      else {
        await credentials.revoke(repo, id!, user!)
        write(JSON.stringify({ repo, id, revoked: true }))
      }
    } catch (error) {
      writeError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
      credentialResult = 2
    } finally {
      try {
        await credentials?.close()
      } catch (error) {
        writeError(error instanceof Error ? error.message : String(error))
        credentialResult = 2
      }
    }
    return credentialResult
  }
  if (args[0] !== 'projects') return runTokenCli(args, env, write, writeError)
  let registry: ProjectRegistry | undefined
  let result = 0
  try {
    const command = args[1]
    if (command === 'list') {
      if (args.length !== 2) throw new Error('projects list takes no options')
    } else if (command === 'add' || command === 'remove') {
      if (
        args.length !== 5 ||
        args[3] !== '--user' ||
        !args[4]?.trim() ||
        args[4].startsWith('--')
      ) {
        throw new Error('projects add/remove requires REPOSITORY --user IDENTITY')
      }
      normalizeProjectRepository(args[2]!)
    } else throw new Error('expected projects list, add, or remove')
    registry = await open(env)
    if (command === 'list') write(JSON.stringify(await registry.list()))
    else if (command === 'add') write(JSON.stringify(await registry.add(args[2]!, args[4]!)))
    else {
      await registry.remove(args[2]!, args[4]!)
      write(JSON.stringify({ repo: normalizeProjectRepository(args[2]!), removed: true }))
    }
  } catch (error) {
    writeError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    result = 2
  } finally {
    try {
      await registry?.close()
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error))
      result = 2
    }
  }
  return result
}

if (import.meta.main) {
  process.exitCode = await runHostedCli(process.argv.slice(2))
}
