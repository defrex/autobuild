import { describe, expect, test } from 'bun:test'
import { ConfigError, parseConfig } from './load'

const base = `
[tickets]
source = "file"
readyState = "ready"
`

function rejection(text: string): string {
  try {
    parseConfig(`${base}${text}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as Error).message
  }
  throw new Error('expected a config error')
}

describe('[[generated]] configuration', () => {
  test('parses declared generated files and their commands', () => {
    const config = parseConfig(`${base}
[[generated]]
paths = ["shapes.json"]
command = "bun tools/shapes.ts"

[[generated]]
paths = ["docs/baseline/**", "docs/index.json"]
command = "bun run docs:baseline"
`)
    expect(config.generated).toEqual([
      { paths: ['shapes.json'], command: 'bun tools/shapes.ts' },
      { paths: ['docs/baseline/**', 'docs/index.json'], command: 'bun run docs:baseline' },
    ])
  })

  test('an absent table leaves the parsed config without the key', () => {
    const config = parseConfig(base)
    expect(config.generated).toBeUndefined()
    expect(Object.hasOwn(config, 'generated')).toBe(false)
  })

  test('rejects empty paths', () => {
    expect(rejection(`[[generated]]\npaths = []\ncommand = "x"\n`)).toContain(
      'generated[0].paths: paths must contain at least one repository-relative glob',
    )
  })

  test('rejects a blank command', () => {
    expect(rejection(`[[generated]]\npaths = ["a"]\ncommand = "   "\n`)).toContain(
      'generated[0].command: command must be a nonblank shell command',
    )
  })

  test('rejects an invalid selector', () => {
    expect(rejection(`[[generated]]\npaths = ["/abs"]\ncommand = "x"\n`)).toContain(
      'generated[0].paths[0]: path selectors must be repository-relative, not absolute',
    )
  })

  test('rejects a selector declared by two entries', () => {
    expect(
      rejection(
        `[[generated]]\npaths = ["a", "b"]\ncommand = "x"\n[[generated]]\npaths = ["b"]\ncommand = "y"\n`,
      ),
    ).toContain(
      'generated[1].paths[0]: generated path selector "b" is declared by both generated[0] and generated[1]',
    )
  })

  test('rejects unknown keys', () => {
    expect(rejection(`[[generated]]\npaths = ["a"]\ncommand = "x"\ncheck = "y"\n`)).toContain(
      'generated[0]',
    )
  })
})
