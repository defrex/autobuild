import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchRuntimeGuestRelease } from './dispatch-runtime-release'

test('the isolated release resolver returns exact bytes and contains transport diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-guest-release-'))
  const module = join(root, 'release.ts')
  try {
    await writeFile(
      module,
      `export async function fetchDistributionReleaseAsset(version) { if (version !== '1.2.3') throw new Error('wrong version'); return new Uint8Array([1,2,3,255]) }`,
    )
    expect([...(await fetchRuntimeGuestRelease('1.2.3', module))]).toEqual([1, 2, 3, 255])
    await writeFile(
      module,
      `export async function fetchDistributionReleaseAsset() { throw new Error('credential-secret') }`,
    )
    let failure = ''
    try {
      await fetchRuntimeGuestRelease('1.2.3', module)
    } catch (error) {
      failure = String(error)
    }
    expect(failure).toContain("verify the version's GitHub release asset")
    expect(failure).not.toContain('credential-secret')
    await writeFile(
      module,
      `export async function fetchDistributionReleaseAsset() { return new Uint8Array([4]) }`,
    )
    expect([...(await fetchRuntimeGuestRelease('1.2.3', module))]).toEqual([4])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
