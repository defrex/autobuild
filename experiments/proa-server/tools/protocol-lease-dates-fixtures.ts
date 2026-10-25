/** Actual Bun Date oracle at TimeClip, leap and expanded-year boundaries. */
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
export function leaseDateFixtures() {
  const values = [
    0,
    -0,
    0.9,
    -0.9,
    1,
    -1,
    86400000,
    -86400000,
    Date.parse('0000-01-01T00:00:00Z'),
    Date.parse('0099-12-31T23:59:59.999Z'),
    Date.parse('1900-02-28T23:59:59.999Z'),
    Date.parse('2000-02-29T12:34:56.789Z'),
    Date.parse('9999-12-31T23:59:59.999Z'),
    Date.parse('+010000-01-01T00:00:00Z'),
    8e15,
    8.4e15,
    8.64e15,
    8.64e15 - 1,
    8.64e15 + 1,
    -8.64e15,
    -8.64e15 - 1,
    Number.MAX_SAFE_INTEGER,
    ...[8e15, 8.4e15, Number.MAX_SAFE_INTEGER].map(
      (ttl) => Date.parse('2030-01-01T00:00:00Z') + ttl,
    ),
  ]
  return {
    dates: values.map((millis) => {
      // Fixture transport uses JSON.stringify, which spells negative zero as 0.
      const encodedMillis = Object.is(millis, -0) ? 0 : millis
      try {
        return { millis: encodedMillis, iso: new Date(millis).toISOString() }
      } catch (error) {
        return {
          millis: encodedMillis,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  }
}
const path = resolve(import.meta.dir, '../fixtures/protocol-lease-dates.json')
if (import.meta.main) {
  const fixture = leaseDateFixtures()
  if (process.argv.includes('--generate')) {
    const formatted = Bun.spawnSync(
      [
        resolve(import.meta.dir, '../../../node_modules/.bin/biome'),
        'format',
        '--stdin-file-path',
        path,
      ],
      { stdin: Buffer.from(JSON.stringify(fixture)) },
    )
    if (formatted.exitCode) throw Error(formatted.stderr.toString())
    await Bun.write(path, formatted.stdout)
  } else if (!isDeepStrictEqual(fixture, await Bun.file(path).json()))
    throw Error('Lease dates stale; regenerate --generate')
  console.log(`${fixture.dates.length} Bun Date boundary cases`)
}
