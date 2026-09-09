import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')
const SMOKE_SCRIPT = join(REPO_ROOT, 'scripts/browser-smoke.sh')
const MARKER = 'AUTOBUILD_BROWSER_SMOKE_RENDERED'
let fixture = ''
let chromium = ''
let helper = ''

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'autobuild-browser-smoke-test-'))
  chromium = join(fixture, 'fake-chromium.sh')
  helper = join(fixture, 'fake-chromium.ts')
  await writeFile(
    chromium,
    `#!/bin/sh
url=''
for argument in "$@"; do url=$argument; done
printf '%s\\n' "$url" >"$OBSERVED_URL_FILE"
exec "$TEST_BUN" "$FAKE_CHROMIUM_HELPER" "$url"
`,
  )
  await chmod(chromium, 0o755)
  await writeFile(
    helper,
    `const url = process.argv[2]
const response = await fetch(url)
const source = await response.text()
if (!response.ok || !source.includes('PENDING') || source.includes('${MARKER}')) {
  console.error('fake Chromium did not receive a pending, pre-render smoke page')
  process.exit(18)
}
switch (process.env.TEST_MODE) {
  case 'browser-failure':
    console.error('modeled Chromium crash')
    process.exit(17)
  case 'mismatch':
    console.log('<html><body>WRONG_RENDER_RESULT</body></html>')
    break
  default:
    console.log('<html><body>${MARKER}</body></html>')
}
`,
  )
})

afterAll(async () => {
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

type SmokeResult = { exitCode: number; output: string; url?: string }

async function runSmoke(
  mode: string,
  overrides: Record<string, string | undefined> = {},
  script = SMOKE_SCRIPT,
): Promise<SmokeResult> {
  const observedUrl = join(fixture, `url-${crypto.randomUUID()}`)
  const env: Record<string, string | undefined> = {
    ...process.env,
    BUN_BIN: process.execPath,
    CHROMIUM_BIN: chromium,
    FAKE_CHROMIUM_HELPER: helper,
    OBSERVED_URL_FILE: observedUrl,
    TEST_BUN: process.execPath,
    TEST_MODE: mode,
    ...overrides,
  }
  const child = Bun.spawn([script], {
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const urlFile = Bun.file(observedUrl)
  const url = (await urlFile.exists()) ? (await urlFile.text()).trim() : undefined
  return { exitCode, output: stdout + stderr, url }
}

async function expectServerStopped(url: string | undefined): Promise<void> {
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  await expect(fetch(url!)).rejects.toThrow()
}

describe('browser smoke workflow', () => {
  test('renders the local page and cleans up its server', async () => {
    const result = await runSmoke('success')

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain(`browser-smoke passed: rendered marker ${MARKER}`)
    await expectServerStopped(result.url)
  })

  test('reports a browser failure and cleans up its server', async () => {
    const result = await runSmoke('browser-failure')

    expect(result.exitCode).toBe(4)
    expect(result.output).toContain('browser-smoke browser failure')
    expect(result.output).toContain('browser exit status: 17')
    expect(result.output).toContain('modeled Chromium crash')
    await expectServerStopped(result.url)
  })

  test('reports a render mismatch and cleans up its server', async () => {
    const result = await runSmoke('mismatch')

    expect(result.exitCode).toBe(5)
    expect(result.output).toContain(`expected marker '${MARKER}'`)
    expect(result.output).toContain('WRONG_RENDER_RESULT')
    await expectServerStopped(result.url)
  })

  test('reports an invalid explicit Bun prerequisite', async () => {
    const result = await runSmoke('success', { BUN_BIN: join(fixture, 'missing-bun') })

    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('browser-smoke prerequisite failure')
    expect(result.output).toContain('no executable Bun runtime found')
  })

  test('surfaces page-server startup output', async () => {
    const failingBun = join(fixture, 'failing-bun.sh')
    await writeFile(failingBun, "#!/bin/sh\necho 'modeled Bun startup failure' >&2\nexit 23\n")
    await chmod(failingBun, 0o755)
    const result = await runSmoke('success', { BUN_BIN: failingBun })

    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('browser-smoke server startup failure')
    expect(result.output).toContain('modeled Bun startup failure')
  })

  test('falls back to bun on PATH for developer hosts', async () => {
    const fallbackFixture = join(fixture, `fallback-${crypto.randomUUID()}`)
    const bin = join(fallbackFixture, 'bin')
    await mkdir(bin, { recursive: true })
    const fallbackMarker = join(fallbackFixture, 'used')
    const bun = join(bin, 'bun')
    await writeFile(
      bun,
      `#!/bin/sh
printf 'used\\n' >"$FALLBACK_MARKER"
exec "$REAL_BUN" "$@"
`,
    )
    await chmod(bun, 0o755)
    const fallbackScript = join(fallbackFixture, 'browser-smoke.sh')
    const scriptSource = await readFile(SMOKE_SCRIPT, 'utf8')
    await writeFile(
      fallbackScript,
      scriptSource.replace(
        "ADAPTER_BUN='/opt/autobuild-runtime/node_modules/.bin/bun'",
        `ADAPTER_BUN='${join(fallbackFixture, 'unavailable-adapter-bun')}'`,
      ),
    )
    await chmod(fallbackScript, 0o755)
    await writeFile(
      join(fallbackFixture, 'browser-smoke-server.ts'),
      await readFile(join(REPO_ROOT, 'scripts/browser-smoke-server.ts')),
    )
    const result = await runSmoke(
      'success',
      {
        BUN_BIN: undefined,
        FALLBACK_MARKER: fallbackMarker,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        REAL_BUN: process.execPath,
      },
      fallbackScript,
    )

    expect(result.exitCode).toBe(0)
    expect(await Bun.file(fallbackMarker).text()).toBe('used\n')
    await expectServerStopped(result.url)
  })
})
