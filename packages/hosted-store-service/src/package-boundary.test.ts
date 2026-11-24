import { describe, expect, test } from 'bun:test'
import { dispatcherDependencyNames, dispatcherSpecifiers } from './testing/dispatcher-boundary'

describe('dispatcher runtime-load boundary', () => {
  test('dependency filter is anchored to the exact dispatcher package name', () => {
    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher'])).toEqual([
      '@defrex/autobuild-hosted-dispatcher',
    ])
    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher/kernel'])).toEqual([
      '@defrex/autobuild-hosted-dispatcher/kernel',
    ])

    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher-tools'])).toEqual([])

    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher_2'])).toEqual([])
    expect(dispatcherDependencyNames(['@defrex/autobuild-hosted-dispatcher2'])).toEqual([])

    expect(
      dispatcherDependencyNames([
        '@defrex/autobuild-postgres-store',
        '@defrex/autobuild-hosted-store-service',
        '@defrex/autobuild',
        'pg',
      ]),
    ).toEqual([])
  })

  test('scan flags every import form that could load the dispatcher', () => {
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
    expect(dispatcherSpecifiers("export * from './dispatcher'")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("export { kernel } from './dispatcher'")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("export * as ns from './dispatcher'")).toEqual(['./dispatcher'])

    expect(dispatcherSpecifiers(`const x = \`\${await import('./dispatcher')}\``)).toEqual([
      './dispatcher',
    ])

    expect(dispatcherSpecifiers('const m = await import(`./dispatcher`)')).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers('const m = await import(`@defrex/autobuild-hosted-dispatcher`)'),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher'])
    expect(
      dispatcherSpecifiers(
        `const m = await import(\`@defrex/autobuild-hosted-dispatcher/\${name}\`)`,
      ),
    ).toEqual([`@defrex/autobuild-hosted-dispatcher/\${name}`])
    expect(dispatcherSpecifiers('const m = await import(`./dispatcher` + suffix)')).toEqual([
      './dispatcher',
    ])

    expect(dispatcherSpecifiers("import './dispatcher.js'")).toEqual(['./dispatcher.js'])
    expect(dispatcherSpecifiers("import x from './dispatcher/index.js'")).toEqual([
      './dispatcher/index.js',
    ])
    expect(dispatcherSpecifiers("export * from './dispatcher.js'")).toEqual(['./dispatcher.js'])
    expect(dispatcherSpecifiers("const m = await import('./dispatcher.js')")).toEqual([
      './dispatcher.js',
    ])

    expect(
      dispatcherSpecifiers("import { store } from '@defrex/autobuild-postgres-store'"),
    ).toEqual([])
    expect(dispatcherSpecifiers("import './service'")).toEqual([])
    expect(dispatcherSpecifiers("void import('@defrex/autobuild-postgres-store')")).toEqual([])
    expect(dispatcherSpecifiers("import { x } from '@defrex/autobuild'")).toEqual([])

    expect(dispatcherSpecifiers('void import(`./service`)')).toEqual([])
    expect(dispatcherSpecifiers('import(`@defrex/autobuild-postgres-store`)')).toEqual([])
    expect(dispatcherSpecifiers(`import(\`./\${name}\`)`)).toEqual([])

    expect(dispatcherSpecifiers("import './dispatcherish'")).toEqual([])
    expect(dispatcherSpecifiers("import './dispatcher-utils'")).toEqual([])
    expect(dispatcherSpecifiers("const m = await import('./dispatcherish')")).toEqual([])
    expect(dispatcherSpecifiers("const m = await import('./dispatcher-utils')")).toEqual([])

    expect(
      dispatcherSpecifiers("import { x } from '@defrex/autobuild-hosted-dispatcher-tools'"),
    ).toEqual([])
    expect(
      dispatcherSpecifiers("const m = await import('@defrex/autobuild-hosted-dispatcher-tools')"),
    ).toEqual([])
    expect(dispatcherSpecifiers('require(`@defrex/autobuild-hosted-dispatcher-tools`)')).toEqual([])
    expect(
      dispatcherSpecifiers(
        `const m = await import(\`@defrex/autobuild-hosted-dispatcher\${path}\`)`,
      ),
    ).toEqual([`@defrex/autobuild-hosted-dispatcher\${path}`])
  })

  test('require scan catches template-literal and non-call require forms', () => {
    expect(dispatcherSpecifiers('const d = require(`./dispatcher`)')).toEqual(['./dispatcher'])
    expect(
      dispatcherSpecifiers(`const d = require(\`@defrex/autobuild-hosted-dispatcher/\${name}\`)`),
    ).toEqual([`@defrex/autobuild-hosted-dispatcher/\${name}`])
    expect(dispatcherSpecifiers('const d = require(`./dispatcher` + suffix)')).toEqual([
      './dispatcher',
    ])

    expect(dispatcherSpecifiers("new require('./dispatcher')")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("module.require('./dispatcher')")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("globalThis.require('./dispatcher')")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("require.call(null, './dispatcher')")).toEqual(['./dispatcher'])
    expect(dispatcherSpecifiers("require.apply(null, ['./dispatcher'])")).toEqual(['./dispatcher'])

    expect(
      dispatcherSpecifiers(
        "const require = createRequire(import.meta.url)\nrequire('./dispatcher')",
      ),
    ).toEqual(['./dispatcher'])

    expect(dispatcherSpecifiers("module.require('./service')")).toEqual([])
    expect(dispatcherSpecifiers('const d = require(`./service`)')).toEqual([])
    expect(dispatcherSpecifiers("require.call(null, './service')")).toEqual([])
    expect(dispatcherSpecifiers("new require('./service')")).toEqual([])

    expect(dispatcherSpecifiers("const f = require.bind(null, './dispatcher')")).toEqual([])
    expect(dispatcherSpecifiers("require['call'](null, './dispatcher')")).toEqual([])
  })

  test('argument-subtree collection is ruled deliberate: require-side non-specifier dispatcher strings still report', () => {
    expect(dispatcherSpecifiers("require('./service', { fallback: './dispatcher' })")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("module.require('./service', { log: './dispatcher' })")).toEqual([
      './dispatcher',
    ])
    expect(dispatcherSpecifiers("require.apply(null, ['./service', './dispatcher'])")).toEqual([
      './dispatcher',
    ])

    expect(dispatcherSpecifiers("require('./service', { fallback: './helper' })")).toEqual([])
    expect(dispatcherSpecifiers("require.apply(null, ['./service', './helper'])")).toEqual([])

    expect(
      dispatcherSpecifiers(
        "await import('./service', { with: { type: 'json' }, fallback: './dispatcher' })",
      ),
    ).toEqual([])
  })

  test('dispatcher-import text inside comments or strings is not an offender', () => {
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
    expect(dispatcherSpecifiers("// require('./dispatcher.js')")).toEqual([])
    expect(
      dispatcherSpecifiers(`const hint = "require('./dispatcher') to load the kernel"`),
    ).toEqual([])
  })

  test('regex-literal bodies and division never mask or fake an import', () => {
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
    expect(dispatcherSpecifiers("const re = /import '\\.\\/dispatcher'/")).toEqual([])
  })

  test('fail-closed edges: unparseable files are flagged, shebangs are inert', () => {
    expect(dispatcherSpecifiers('const x = = =')).toEqual(['<unparseable module>'])
    expect(dispatcherSpecifiers("#!/usr/bin/env bun\nimport './dispatcher'")).toEqual([
      './dispatcher',
    ])
  })

  test('inline type-only named imports are flagged: verbatimModuleSyntax preserves them', () => {
    expect(
      dispatcherSpecifiers("import { type T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/types'])
    expect(
      dispatcherSpecifiers(
        "import { type T, type U } from '@defrex/autobuild-hosted-dispatcher/types'",
      ),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/types'])
    expect(
      dispatcherSpecifiers(
        "import { kernel, type T } from '@defrex/autobuild-hosted-dispatcher/kernel'",
      ),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/kernel'])
    expect(
      dispatcherSpecifiers("export { type T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual(['@defrex/autobuild-hosted-dispatcher/types'])
  })

  test('fully type-only imports are intentionally not flagged', () => {
    expect(
      dispatcherSpecifiers("import type { T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual([])
    expect(
      dispatcherSpecifiers("import type * as ns from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual([])
    expect(
      dispatcherSpecifiers("export type { T } from '@defrex/autobuild-hosted-dispatcher/types'"),
    ).toEqual([])
  })
})
