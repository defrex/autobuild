import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')

describe('the real sub-package manifests', () => {
  const AUT_490_BROADENED_FILES = [
    'src',
    'README.md',
    '!src/**/*.test.ts',
    '!src/**/*.test.tsx',
    '!src/**/*.spec.ts',
    '!src/**/*.spec.tsx',
  ]

  // postgres-store alone carries the AUT-500 negation; the other two
  // sub-packages must keep pinning the AUT-490 shape exactly.
  const POSTGRES_AUT_500_FILES = [...AUT_490_BROADENED_FILES, '!src/testing/**']
  const AUT_500_FILES_BY_DIRECTORY: Record<string, string[]> = {
    'hosted-dispatcher': [...AUT_490_BROADENED_FILES, '!src/testing/**'],
    // The self-hosting guide ships beside the README (AUT-1081).
    'hosted-store-service': [
      'src',
      'README.md',
      'SELF-HOSTING.md',
      ...AUT_490_BROADENED_FILES.slice(2),
      '!src/testing/**',
      'app',
      'server.ts',
      'next.config.ts',
      'tsconfig.deploy.json',
      'next-env.d.ts',
      'deployment',
      '!app/**/*.test.ts',
      '!app/**/*.test.tsx',
      '!app/**/*.spec.ts',
      '!app/**/*.spec.tsx',
    ],
    'postgres-store': POSTGRES_AUT_500_FILES,
  }

  for (const directory of ['hosted-dispatcher', 'hosted-store-service', 'postgres-store']) {
    test(`packages/${directory}/package.json's files allowlist carries the broadened AUT-490 negations exactly`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, 'packages', directory, 'package.json'), 'utf8'),
      ) as { files?: unknown }
      expect(manifest.files).toEqual(AUT_500_FILES_BY_DIRECTORY[directory])
    })
  }
})

describe('the real root manifest', () => {
  // Pinned byte-for-byte (AUT-490 + AUT-503 + AUT-508 + AUT-506 + AUT-513 + AUT-552): the root tarball ships packages/core/src
  // except its *.test.ts, *.test.tsx, *.spec.ts, and *.spec.tsx files (AUT-490's negation,
  // broadened to the four spellings by AUT-508), the AUT-503 per-file negations of the
  // test-only src/testing helpers, the AUT-506 per-file negation of the test-only
  // src/cli/testkit.ts helper, and the AUT-513 per-file negations of the four remaining
  // dead-weight files, whose load-bearing siblings (fixed.ts, index.ts, harness.ts) keep shipping.
  // By AUT-552 the once-allowlisted patches/ directory is dropped from the files set: the
  // workspace install reads the patch from the repo tree, and the packed manifest strips
  // patchedDependencies, so the patch file was dead weight in every packed artifact.
  const ROOT_AUT_552_FILES = [
    'bin',
    'packages/core/src',
    '!packages/core/src/**/*.test.ts',
    '!packages/core/src/**/*.test.tsx',
    '!packages/core/src/**/*.spec.ts',
    '!packages/core/src/**/*.spec.tsx',
    '!packages/core/src/testing/store-failures.ts',
    '!packages/core/src/testing/packed-install.ts',
    '!packages/core/src/cli/testkit.ts',
    '!packages/core/src/cli/store-opening.contract.ts',
    '!packages/core/src/ports/runner/live-contract-fixture.ts',
    '!packages/core/src/cli/dashboard/frame-image.ts',
    '!packages/core/src/markdown.ts',
    'skills',
    'templates',
    'LICENSE',
    'README.md',
    'SPEC.md',
    'docs',
  ]

  test("the root package.json's files allowlist carries the AUT-490 negations broadened by AUT-508 plus the AUT-503, AUT-506, and AUT-513 per-file negations exactly, with patches/ dropped by AUT-552", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      files?: unknown
    }
    expect(manifest.files).toEqual(ROOT_AUT_552_FILES)
  })
})
