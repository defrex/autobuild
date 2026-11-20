/**
 * Guards CLI startup composition (AUT-1278). Production services such as the
 * Vercel sandbox SDK, the ChatGPT identity check's `jose`, agent-provider
 * runtimes and the dispatcher launcher load where execution first uses them,
 * never merely because the shared binary links them. A fresh Bun process
 * imports the two binary entries and reports what it actually loaded.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const BIN = join(ROOT, 'bin', 'ab.ts')

const DEFERRED = [
  /\/@vercel\/sandbox\//,
  /\/node_modules\/\.bun\/jose@/,
  /\/ports\/workspace\/vercel-sandbox\.ts$/,
  /\/ports\/runner\/production\.ts$/,
  /\/cli\/dispatch-launcher\.ts$/,
]

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-startup-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function run(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('AB_')) env[key] = value
  }
  const proc = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test('binary entries load without production service implementations', async () => {
  const probe = join(tmp, 'probe.ts')
  await writeFile(
    probe,
    [
      `await import(${JSON.stringify(join(import.meta.dir, 'binary.ts'))})`,
      `await import(${JSON.stringify(join(import.meta.dir, 'binary-direct.ts'))})`,
      'console.log(JSON.stringify(Object.keys(require.cache)))',
    ].join('\n'),
  )
  const result = await run([probe], tmp)
  expect(result.stderr).toBe('')
  expect(result.code).toBe(0)
  const loaded = (JSON.parse(result.stdout) as string[]).map((path) => path.replaceAll('\\', '/'))
  // The probe cannot pass vacuously: the command router itself is loaded.
  expect(loaded.some((path) => path.endsWith('/cli/main.ts'))).toBe(true)
  for (const pattern of DEFERRED) {
    expect(loaded.filter((path) => pattern.test(path))).toEqual([])
  }
})

test('the real binary still answers version and help', async () => {
  const version = await run([BIN, '--version'], tmp)
  expect(version.code).toBe(0)
  expect(version.stdout.trim()).not.toBe('')
  const help = await run([BIN, '--help'], tmp)
  expect(help.code).toBe(0)
  expect(help.stdout.trim()).not.toBe('')
})
