import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SQL } from 'bun'
import { installPackedDistribution } from '../packages/core/src/testing/packed-install'
import { SCHEMA_VERSION } from '../packages/postgres-store/src/schema'
import { AUTH_SCHEMA_VERSION } from '../packages/postgres-store/src/auth-schema'
import { repoRoot } from './git-tracked'

export const deploymentTemplatePaths = [
  'templates/hosted-service',
  'packages/hosted-store-service/deployment',
]
export async function checkDeploymentTemplates() {
  for (const file of ['package.json', 'vercel.json']) {
    const text = await readFile(join(repoRoot, deploymentTemplatePaths[0]!, file), 'utf8')
    assert.equal(text, await readFile(join(repoRoot, deploymentTemplatePaths[1]!, file), 'utf8'))
    const docs = await readFile(join(repoRoot, 'docs/hosted-service.md'), 'utf8')
    assert(docs.includes(text.trim()), `Documentation must contain canonical ${file}`)
  }
  const manifest = JSON.parse(
    await readFile(join(repoRoot, deploymentTemplatePaths[0]!, 'package.json'), 'utf8'),
  )
  const version = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version
  assert.equal(manifest.dependencies['@defrex/autobuild'], version)
  assert.equal(manifest.dependencies['@defrex/autobuild-hosted-store-service'], version)
}

async function command(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  success = true,
) {
  const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (success && code !== 0)
    throw new Error(`${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`)
  if (!success) assert.notEqual(code, 0, 'Expected command to fail')
  return stdout + stderr
}
async function paths(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    result.push(path)
    if (entry.isDirectory()) result.push(...(await paths(path)))
  }
  return result
}

/** Real packed consumer, outside workspace resolution. This is intentionally a
 * live command rather than another expensive build in the unit test suite. */
export async function checkHostedServicePackaging() {
  await checkDeploymentTemplates()
  const url = process.env.AB_POSTGRES_TEST_URL
  assert(url, 'AB_POSTGRES_TEST_URL is required')
  const root = await mkdtemp(join(tmpdir(), 'ab-service-packaging-'))
  const schema = `ab_pack_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(url)
  let server: ReturnType<typeof Bun.spawn> | undefined
  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const scoped = new URL(url)
    scoped.searchParams.set('options', `-csearch_path=${schema}`)
    const env: Record<string, string | undefined> = {
      ...process.env,
      NODE_PATH: undefined,
      BUN_INSTALL: undefined,
      AB_SERVICE_BUILD_ROOT: undefined,
      AB_POSTGRES_URL: scoped.toString(),
      DATABASE_URL: undefined,
      BETTER_AUTH_URL: 'https://operator.example',
      BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789',
      GITHUB_CLIENT_ID: 'packaging-client',
      GITHUB_CLIENT_SECRET: 'packaging-secret',
      AB_STORE_SECRET: 'packaging-store-secret',
      AB_BLOB_BACKEND: 's3',
      AB_S3_BUCKET: 'unused',
      AB_S3_REGION: 'us-east-1',
      AB_S3_ACCESS_KEY_ID: 'unused',
      AB_S3_SECRET_ACCESS_KEY: 'unused',
      AB_WEB_AUTH_PROVIDERS: 'github',
      AB_WEB_ALLOWED_EMAILS: 'ada@example.com',
      AB_WEB_REPOSITORIES: 'https://github.com/owner/repo',
      NEXT_TELEMETRY_DISABLED: '1',
    }
    const archives: Record<string, string> = {}
    for (const directory of ['.', 'packages/postgres-store', 'packages/hosted-store-service']) {
      const manifest = JSON.parse(await readFile(join(repoRoot, directory, 'package.json'), 'utf8'))
      const archive = join(root, `${manifest.name.replaceAll('/', '-').replace('@', '')}.tgz`)
      await command(
        ['bun', 'pm', 'pack', '--ignore-scripts', '--filename', archive],
        join(repoRoot, directory),
        env,
      )
      archives[manifest.name] = archive
    }
    const consumer = join(root, 'consumer')
    await mkdir(consumer)
    const manifest = JSON.parse(
      await readFile(join(repoRoot, deploymentTemplatePaths[0]!, 'package.json'), 'utf8'),
    )
    // Only test overrides differ from the documented consumer manifest.
    manifest.overrides = archives
    await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2))
    await writeFile(
      join(consumer, 'vercel.json'),
      await readFile(join(repoRoot, deploymentTemplatePaths[0]!, 'vercel.json')),
    )
    const install = await installPackedDistribution([], consumer)
    assert.equal(install.exitCode, 0, install.stdout + install.stderr)
    const installed = join(consumer, 'node_modules/@defrex/autobuild-hosted-store-service')
    assert((await realpath(installed)).startsWith(root))
    const packedPaths = await paths(installed)
    for (const file of [
      'app/mcp/route.ts',
      'app/sign-in/page.tsx',
      'next.config.ts',
      'src/deploy-build.ts',
      'tsconfig.deploy.json',
    ])
      assert(packedPaths.includes(join(installed, file)), `Missing packed asset ${file}`)
    assert(
      !packedPaths.some(
        (path) => /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/.impeccable/'),
      ),
    )
    const missing = await command(
      ['bun', 'run', 'build'],
      consumer,
      { ...env, AB_POSTGRES_URL: undefined, DATABASE_URL: undefined },
      false,
    )
    assert(missing.includes('required and must be nonblank'), missing)
    const failure = await command(
      ['bun', 'run', 'build'],
      consumer,
      {
        ...env,
        AB_POSTGRES_URL: 'postgres://postgres:postgres@127.0.0.1:1/postgres?connect_timeout=1',
      },
      false,
    )
    assert(!failure.includes('Creating an optimized production build'))
    await command(['bun', 'run', 'build'], consumer, env)
    console.log('Packed service migrated and built')
    const db = new SQL(scoped.toString())
    try {
      const markers = await db`SELECT version FROM ab_schema_migrations`
      assert.equal(Number(markers[0]?.version), SCHEMA_VERSION)
      const authMarkers = await db`SELECT version FROM ab_auth_schema_migrations`
      assert.equal(Number(authMarkers[0]?.version), AUTH_SCHEMA_VERSION)
      await command(
        [
          'bun',
          join(dirname(Bun.resolveSync('@defrex/autobuild-postgres-store', installed)), 'bin.ts'),
          'migrate',
        ],
        consumer,
        env,
      )
      // Reserve a free port, then release it immediately before starting Next.
      const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
      const port = reservation.port!
      reservation.stop(true)
      server = Bun.spawn(['bun', 'node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
        cwd: consumer,
        env,
        stdout: 'ignore',
        stderr: 'inherit',
      })
      const origin = `http://localhost:${port}`
      let ready = false
      for (let i = 0; i < 120; i++) {
        try {
          if ((await fetch(`${origin}/health`)).ok) {
            ready = true
            break
          }
        } catch {}
        await Bun.sleep(250)
      }
      assert(ready, 'Production server did not start')
      const get = (path: string) => fetch(`${origin}${path}`, { redirect: 'manual' })
      assert.equal((await get('/health')).status, 200)
      assert.equal((await get('/sign-in')).status, 200)
      assert([302, 303, 307].includes((await get('/')).status))
      const health = (await (await get('/health')).json()) as {
        autobuildVersion: string
        protocolVersion: string
      }
      assert.equal(
        (
          await fetch(`${origin}/builds`, {
            headers: {
              'x-autobuild-version': health.autobuildVersion,
              'x-autobuild-protocol-version': health.protocolVersion,
            },
          })
        ).status,
        401,
      )
      const challenge = await get('/mcp')
      assert.equal(challenge.status, 401)
      assert(challenge.headers.get('www-authenticate')?.includes('resource_metadata'))
      const dispatch = await get('/api/dispatch')
      assert.equal(dispatch.status, 503)
      assert.deepEqual(await dispatch.json(), {
        error: 'dispatch runs elsewhere for this deployment',
      })
      const resource = (await (
        await get('/.well-known/oauth-protected-resource')
      ).json()) as Record<string, unknown>
      assert.equal(resource.resource, `${env.BETTER_AUTH_URL}/mcp`)
      assert.deepEqual(resource.authorization_servers, [env.BETTER_AUTH_URL])
      const metadata = (await (
        await get('/.well-known/oauth-authorization-server')
      ).json()) as Record<string, string>
      assert.equal(metadata.issuer, env.BETTER_AUTH_URL)
      const local = (url: string) => `${origin}${new URL(url).pathname}`
      assert.equal((await fetch(local(metadata.jwks_uri!))).status, 200)
      const registration = await fetch(local(metadata.registration_endpoint!), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Packed service check',
          redirect_uris: ['https://client.example/callback'],
          token_endpoint_auth_method: 'none',
        }),
      })
      assert.equal(registration.status, 201)
      const client = (await registration.json()) as {
        client_id: string
        token_endpoint_auth_method: string
      }
      assert.equal(typeof client.client_id, 'string')
      assert(client.client_id.length > 0)
      assert.equal(client.token_endpoint_auth_method, 'none')
      const persisted =
        await db`SELECT "authenticationScheme" FROM "oauthApplication" WHERE "clientId" = ${client.client_id}`
      assert.equal(persisted[0]?.authenticationScheme, 'none')
    } finally {
      await db.close()
    }
    server.kill()
    await server.exited
    server = undefined
    console.log('Production HTTP discovery and registration passed')
    // A local Build Output API build: project settings are fixtures, no account
    // connection or deployment occurs. Vercel validates vercel.json itself.
    await mkdir(join(consumer, '.vercel'))
    await writeFile(
      join(consumer, '.vercel/project.json'),
      JSON.stringify({
        projectId: 'prj_packaging',
        orgId: 'team_packaging',
        projectName: 'packaging-check',
        settings: {
          framework: 'nextjs',
          buildCommand: 'bun run build',
          installCommand: 'bun install --frozen-lockfile',
          nodeVersion: '22.x',
        },
      }),
    )
    const vercel = join(repoRoot, 'packages/hosted-store-service/node_modules/vercel/dist/index.js')
    await command(['bun', vercel, 'build', '--yes'], consumer, {
      ...env,
      VERCEL_TELEMETRY_DISABLED: '1',
      VERCEL_TOKEN: undefined,
    })
    const output = join(consumer, '.vercel/output')
    const config = await readFile(join(output, 'config.json'), 'utf8')
    assert(config.includes('oauth-protected-resource'))
    assert(config.includes('oauth-authorization-server'))
    const functions = await paths(join(output, 'functions'))
    for (const route of ['health', 'mcp', 'api/auth'])
      assert(
        functions.some((path) => path.includes(route)),
        `Missing Vercel function ${route}`,
      )
    assert(!functions.some((path) => path.includes('autobuild-hosted-dispatcher')))
    const generated = JSON.parse(config) as { crons?: unknown[] }
    assert.equal(generated.crons?.length ?? 0, 0)
    console.log('Packed Vercel service deployment passed')
  } finally {
    if (server) {
      server.kill()
      await server.exited
    }
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.close()
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) await checkHostedServicePackaging()
