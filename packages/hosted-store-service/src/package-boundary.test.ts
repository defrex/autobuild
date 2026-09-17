import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * The store service hosts state only: after the hosted dispatcher moved to
 * `@defrex/autobuild-hosted-dispatcher`, no module here may import it and the
 * manifest must neither export it nor depend on it or on any workspace
 * sandbox provider. A deployment that installs only the store service then
 * never loads the dispatcher's kernel/provider closure.
 */
const packageDirectory = join(import.meta.dir, '..')

async function readManifest(): Promise<{
  exports?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}> {
  return JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>
    dependencies?: Record<string, unknown>
    peerDependencies?: Record<string, unknown>
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

/**
 * Specifiers that would load the dispatcher. Applied to every import form the
 * scanner recognizes.
 */
const DISPATCHER_SPECIFIER = /^(\.\/dispatcher$)|(^@defrex\/autobuild-hosted-dispatcher)/

/**
 * Parser-based extraction of dispatcher specifiers (Bun.Transpiler.scanImports
 * with the `ts` loader) — NOT regex-based. Because a real parser scopes
 * specifiers to import statements, dispatcher-import text confined to a line
 * or block comment, a string/template-literal interior, or a regex-literal
 * body can never yield an offender. Type-only imports (`import type` /
 * `export type ... from`) are intentionally not flagged: they are erased at
 * compile time and cannot load the dispatcher. Every import form that could
 * load the dispatcher is reported: static `from` specifiers (including
 * `export ... from`), bare side-effect `import '...'`, dynamic `import('...')`,
 * and `require('...')` (defensively; the package is ESM and has no require
 * today). A static-only scan would let a side-effect or dynamic import
 * silently reintroduce the dispatcher's kernel/provider closure.
 *
 * Fail-closed edges: a leading `#!` shebang line is stripped as inert comment
 * text (Bun's transpiler otherwise throws on it); any other parse failure
 * yields the `<unparseable module>` sentinel so the tree walk reports the
 * whole file as an offender rather than skipping it.
 */
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const UNPARSEABLE_MODULE = '<unparseable module>'

export function dispatcherSpecifiers(text: string): string[] {
  const stripped = text.replace(/^#![^\n]*\n?/, '')
  try {
    return transpiler
      .scanImports(stripped)
      .map((found) => found.path)
      .filter((path) => DISPATCHER_SPECIFIER.test(path))
  } catch {
    return [UNPARSEABLE_MODULE]
  }
}

describe('hosted-store-service package boundary', () => {
  test('manifest has no dispatcher export and no dispatcher or provider dependency', async () => {
    const manifest = await readManifest()
    expect(Object.keys(manifest.exports ?? {})).not.toContain('./dispatcher')
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]
    expect(dependencyNames.filter((name) => name.includes('hosted-dispatcher'))).toEqual([])
    expect(
      dependencyNames.filter(
        (name) => name === '@vercel/sandbox' || name.startsWith('@defrex/autobuild-'),
      ),
    ).toEqual(['@defrex/autobuild-postgres-store'])
  })

  test('no module imports the dispatcher', async () => {
    const files = await sourceFiles(join(packageDirectory, 'src'))
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const specifier of dispatcherSpecifiers(text)) {
        offenders.push(`${file}: ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('scan flags every import form that could load the dispatcher', () => {
    // Positive: every import form that could load the dispatcher is flagged.
    expect(
      dispatcherSpecifiers("import { kernel } from '@defrex/autobuild-hosted-dispatcher/kernel'"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/kernel'])
    expect(dispatcherSpecifiers("import './dispatcher'")).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers("const m = await import('@defrex/autobuild-hosted-dispatcher')"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher'])
    expect(dispatcherSpecifiers("const d = require('./dispatcher')")).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers(
        `const m = await import(
  './dispatcher'
)`,
      ),
    ).toEqual(['./dispatcher'])
    // Re-export forms load the dispatcher too.
    expect(dispatcherSpecifiers("export * from './dispatcher'")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("export { kernel } from './dispatcher'")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("export * as ns from './dispatcher'")).toEqual(['./dispatcher'])

    // Evasion guard: a real dynamic import inside a template interpolation is
    // still flagged even though the surrounding text is a template literal.
    // (The `\${` escapes keep the fixture's interpolation out of this file's
    // own syntax; the fixture text still carries a real `${...}`.)
    expect(dispatcherSpecifiers(`const x = \`\${await import('./dispatcher')}\``)).toEqual([
      './dispatcher',
    ])

    // Negative controls: legitimate specifiers stay clean.
    expect(
      dispatcherSpecifiers("import { store } from '@defrex/autobuild-postgres-store'"),
    ).toEqual([])
    expect(dispatcherSpecifiers("import './service'")).toEqual([])
    expect(dispatcherSpecifiers("void import('@defrex/autobuild-postgres-store')")).toEqual([])
    expect(dispatcherSpecifiers("import { x } from '@defrex/autobuild'")).toEqual([])
  })

  test('dispatcher-import text inside comments or strings is not an offender', () => {
    // The ticket: raw text matching would flag documentation and
    // commented-out code. The parser scopes specifiers to import statements,
    // so none of these can load the dispatcher.
    expect(dispatcherSpecifiers("// import './dispatcher'")).toEqual([])
    expect(dispatcherSpecifiers("// import '@defrex/autobuild-hosted-dispatcher'")).toEqual([])
    expect(
      dispatcherSpecifiers(
        `/*
import './dispatcher'
*/`,
      ),
    ).toEqual([])
    expect(
      dispatcherSpecifiers(
        `/**
 * @see import '@defrex/autobuild-hosted-dispatcher'
 */
export const x = 1`,
      ),
    ).toEqual([])
    expect(dispatcherSpecifiers(`const hint = "import './dispatcher' to load the kernel"`)).toEqual(
      [],
    )
    expect(dispatcherSpecifiers(`const hint = 'import "./dispatcher" to load the kernel'`)).toEqual(
      [],
    )
    expect(dispatcherSpecifiers(`const doc = "see import './dispatcher'"`)).toEqual([])
    expect(
      dispatcherSpecifiers(`const doc = \`import './dispatcher' when wiring the kernel manually\``),
    ).toEqual([])
  })

  test('regex-literal bodies and division never mask or fake an import', () => {
    // Regression guards for the hand-rolled-mask desync classes that
    // motivated the parser pivot: a real parser resolves regex-vs-division
    // from grammar, so none of these can desync the scan.
    expect(dispatcherSpecifiers("const re = /[/*]/\nimport './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("const re = /\\/\\//; import './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("const re = /[/]/; import './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("const re = /it's/; import './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("if (cond) /[/*]/.test(s)\nimport './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("if (cond) /[//]/.test(s); import './dispatcher'")).toEqual([
      './dispatcher',
    ])
    expect(
      dispatcherSpecifiers(
        "const x = a / b * 'A/B' ; import './dispatcher' ; const z = 'C'\nconst w = 'D'",
      ),
    ).toEqual(['./dispatcher'])
    // A regex whose body contains dispatcher-import text is not an import.
    expect(dispatcherSpecifiers("const re = /import '\\.\\/dispatcher'/")).toEqual([])
  })

  test('fail-closed edges: unparseable files are flagged, shebangs are inert', () => {
    // A file the parser cannot read is reported wholesale rather than
    // silently skipped.
    expect(dispatcherSpecifiers('const x = = =')).toEqual(['<unparseable module>'])
    // A shebang is inert comment text; stripping it cannot hide an import.
    expect(dispatcherSpecifiers("#!/usr/bin/env bun\nimport './dispatcher'")).toEqual([
      './dispatcher',
    ])
  })

  test('type-only imports are intentionally not flagged', () => {
    // Intentional narrowing: `import type` / `export type ... from` are
    // erased at compile time and cannot load the dispatcher, so the parser
    // does not report them.
    expect(
      dispatcherSpecifiers("import type { T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual([])
    expect(
      dispatcherSpecifiers("export type { T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual([])
  })
})
