import { describe, expect, test } from 'bun:test'
import {
  type PackRequest,
  type PackResult,
  type PublishContentsCheckOutput,
  evaluatePackedPaths,
  parsePackedPaths,
  runPublishContentsCheck,
} from './publish-contents-check'

/**
 * Byte-shaped after the real bun 1.4.0 output this check parses: the banner,
 * `packed <size> <path>` lines with size spellings (`320B`, `2.1KB`) and
 * bracketed route paths, the tgz-name line, and the totals trailer. The
 * listing is trimmed to representative files; the parser keys on the line
 * shape, not the count.
 */
const happyListing = [
  'bun pack v1.4.0 (34cbb9a40)',
  '',
  'packed 2.11KB package.json',
  'packed 10.78KB README.md',
  'packed 4.1KB src/bin.ts',
  'packed 320B src/web/runtime.ts',
  'packed 1.59KB src/app-route-with-brackets/[...all]/route.ts',
  '',
  'defrex-autobuild-hosted-store-service-0.8.0.tgz',
  '',
  'Total files: 6',
  'Unpacked size: 0.02MB',
  '',
].join('\n')

/** The pre-ruling listing shape: the moved checkout/Vercel surface present. */
const leakedListing = [
  'bun pack v1.4.0 (34cbb9a40)',
  '',
  'packed 2.1KB package.json',
  'packed 10.1KB README.md',
  'packed 2.58KB .impeccable/surfaces/app-dashboard-dashboardclient-tsx.md',
  'packed 0.59KB app/api/auth/[...all]/route.ts',
  'packed 246B next-env.d.ts',
  'packed 2.1KB next.config.ts',
  'packed 272B server.ts',
  'packed 271B tsconfig.json',
  'packed 308B vercel.json',
  'packed 4.1KB src/bin.ts',
  '',
  'defrex-autobuild-hosted-store-service-0.8.0.tgz',
  '',
  'Total files: 12',
  'Unpacked size: 0.03MB',
].join('\n')

describe('parsePackedPaths', () => {
  test('extracts every path from a real-shaped listing and ignores the trailer lines', () => {
    expect(parsePackedPaths(happyListing)).toEqual([
      'package.json',
      'README.md',
      'src/bin.ts',
      'src/web/runtime.ts',
      'src/app-route-with-brackets/[...all]/route.ts',
    ])
  })

  test('a listing with no packed lines yields nothing, which the evaluation fails on', () => {
    const bannerOnly = ['bun pack v1.4.0 (34cbb9a40)', '', 'no files', ''].join('\n')
    expect(parsePackedPaths(bannerOnly)).toEqual([])
  })

  test('handles CRLF endings and dot-prefixed directories', () => {
    expect(parsePackedPaths('packed 2.58KB .impeccable/surfaces/brief.md\r\n')).toEqual([
      '.impeccable/surfaces/brief.md',
    ])
  })
})

describe('evaluatePackedPaths', () => {
  test('the ruling-shaped listing (package.json, README.md, src/**) passes', () => {
    expect(evaluatePackedPaths(parsePackedPaths(happyListing))).toEqual([])
  })

  test('every moved checkout/Vercel artifact is an extra, named by path', () => {
    const violations = evaluatePackedPaths(parsePackedPaths(leakedListing))
    const extras = violations
      .filter((violation) => violation.kind === 'extra')
      .map((violation) => (violation.kind === 'extra' ? violation.path : ''))
    expect(extras).toEqual([
      '.impeccable/surfaces/app-dashboard-dashboardclient-tsx.md',
      'app/api/auth/[...all]/route.ts',
      'next-env.d.ts',
      'next.config.ts',
      'server.ts',
      'tsconfig.json',
      'vercel.json',
    ])
  })

  test('a listing missing src/ fails with missing-src, not silently', () => {
    const violations = evaluatePackedPaths(['package.json', 'README.md'])
    expect(violations).toEqual([{ kind: 'missing-src' }])
  })

  test('a listing missing a required file names it', () => {
    const violations = evaluatePackedPaths(['README.md', 'src/bin.ts'])
    expect(violations).toEqual([{ kind: 'missing', path: 'package.json' }])
  })

  test('an empty parsed listing fails as empty-listing, never as a pass', () => {
    expect(evaluatePackedPaths([])).toEqual([{ kind: 'empty-listing' }])
  })
})

interface CapturedOutput {
  stdout: string[]
  stderr: string[]
}

function capture(): { output: PublishContentsCheckOutput; captured: CapturedOutput } {
  const captured: CapturedOutput = { stdout: [], stderr: [] }
  return {
    captured,
    output: {
      stdout: (message) => captured.stdout.push(message),
      stderr: (message) => captured.stderr.push(message),
    },
  }
}

const packageDirectory = '/repo/packages/hosted-store-service'

function fakeRunner(result: Partial<PackResult>) {
  return async (request: PackRequest): Promise<PackResult> => {
    lastRequest = request
    return { exitCode: 0, stdout: '', stderr: '', ...result }
  }
}

let lastRequest: PackRequest | undefined

describe('runPublishContentsCheck', () => {
  test('the ruling-shaped listing passes and reports the packed counts', async () => {
    const { output, captured } = capture()
    const exitCode = await runPublishContentsCheck(
      { packageDirectory, pack: fakeRunner({ stdout: happyListing }) },
      output,
    )
    expect(exitCode).toBe(0)
    expect(captured.stdout.join('')).toContain('match the ruling')
    // The success message must terminate its line like the failure paths do,
    // so terminal output stops concatenating with the next shell output.
    expect(captured.stdout.join('').endsWith('\n')).toBe(true)
    expect(lastRequest?.command).toBe('bun')
    expect(lastRequest?.args).toEqual(['pm', 'pack', '--dry-run'])
    expect(lastRequest?.cwd).toBe(packageDirectory)
  })

  test('a leaked listing fails nonzero, prints the ruling, and names the offending paths', async () => {
    const { output, captured } = capture()
    const exitCode = await runPublishContentsCheck(
      { packageDirectory, pack: fakeRunner({ stdout: leakedListing }) },
      output,
    )
    expect(exitCode).toBe(1)
    const combined = captured.stdout.join('')
    expect(combined).toContain('Ruling (AUT-463)')
    expect(combined).toContain('.impeccable/surfaces/app-dashboard-dashboardclient-tsx.md')
    expect(combined).toContain('app/api/auth/[...all]/route.ts')
    expect(combined).toContain('server.ts')
    expect(captured.stderr.join('')).toContain('7 packed-contents violation(s)')
  })

  test('a failing pack is a failed check, not a pass', async () => {
    const { output, captured } = capture()
    const exitCode = await runPublishContentsCheck(
      { packageDirectory, pack: fakeRunner({ exitCode: 1, stderr: 'no such package' }) },
      output,
    )
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain('bun pm pack --dry-run failed')
    expect(captured.stderr.join('')).toContain('no such package')
    // Failure paths already ended with a newline; pin that convention too.
    expect(captured.stderr.join('').endsWith('\n')).toBe(true)
  })

  test('a thrown runner is a failed check (fail-closed, like every check here)', async () => {
    const { output, captured } = capture()
    const exitCode = await runPublishContentsCheck(
      {
        packageDirectory,
        pack: async () => {
          throw new Error('spawn failed')
        },
      },
      output,
    )
    expect(exitCode).toBe(1)
    expect(captured.stderr.join('')).toContain(
      'Could not check the hosted-store-service pack contents',
    )
    expect(captured.stderr.join('')).toContain('spawn failed')
  })
})
