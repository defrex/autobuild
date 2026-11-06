import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'

/**
 * Kernel Git that runs inside a shell (`sh -c '… | git …'`) never reaches an
 * argv-level `git` router. A hosted dispatcher has no host `git`, so it routes
 * these through a `git` launcher on the shell's `PATH`, which only an injected
 * `Exec` receives. This guard finds every shell execution site in the
 * dispatcher-side trees and holds each one to an inventory, so a new
 * shell-wrapped Git call cannot slip in on a `Bun.spawn` or go unreviewed.
 */
const src = join(import.meta.dir, '..')
const SCANNED = ['kernel', 'ports/forge', 'ports/workspace', 'processes']
const SHELLS = new Set(['sh', 'bash', '/bin/sh', '/bin/bash'])
const SHELL_FLAG = /^-[a-z]*c[a-z]*$/
const GIT_COMMAND = /(^|[\s|;&()`$]|&&|\|\|)git(\s|$)/
const ROUTED_CALLEE = /^(?:(?:this\.)?deps|input|this|opts)\.exec\($|^run\(deps,$|^exec\($/
const SANDBOX_FILE = 'ports/workspace/vercel-sandbox.ts'

interface ShellSite {
  file: string
  line: number
  form: 'array' | 'object' | 'tagged'
  script: string
  literals: string[]
  dynamic: boolean
  callee: string
  label?: string
  git: boolean
  /** `exec(` bound to a parameter of an enclosing function. */
  execParameter: boolean
  unparsed?: true
}

function stringValue(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
    return node.text
  return undefined
}

/** The literal text of a script expression and whether any part is not. */
function scriptParts(node: ts.Expression): { literals: string[]; dynamic: boolean } {
  const literal = stringValue(node)
  if (literal !== undefined) return { literals: [literal], dynamic: false }
  if (ts.isParenthesizedExpression(node)) return scriptParts(node.expression)
  if (ts.isConditionalExpression(node)) {
    const a = scriptParts(node.whenTrue)
    const b = scriptParts(node.whenFalse)
    return { literals: [...a.literals, ...b.literals], dynamic: a.dynamic || b.dynamic }
  }
  if (ts.isTemplateExpression(node)) {
    const text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('…')
    // Interpolations count as literal only once the static text names Git.
    return { literals: [text], dynamic: !GIT_COMMAND.test(text) }
  }
  return { literals: [], dynamic: true }
}

function calleeOf(node: ts.Node, sourceFile: ts.SourceFile): string {
  const parent = node.parent
  if (parent && ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(node as ts.Expression)
    const before = parent.arguments
      .slice(0, Math.max(index, 0))
      .map((argument) => `${argument.getText(sourceFile)},`)
    return `${parent.expression.getText(sourceFile)}(${before.join(' ')}`.replace(/\s+/g, '')
  }
  return parent ? `<${ts.SyntaxKind[parent.kind]}>` : '<none>'
}

function execIsParameter(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (ts.isFunctionLike(at))
      for (const parameter of at.parameters) {
        const names = ts.isIdentifier(parameter.name)
          ? [parameter.name.text]
          : ts.isObjectBindingPattern(parameter.name)
            ? parameter.name.elements.map((element) => element.name.getText())
            : []
        if (names.includes('exec')) return true
      }
  }
  return false
}

function site(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  form: ShellSite['form'],
  script: ts.Expression | undefined,
  label: string | undefined,
  callee: string,
): ShellSite {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  if (!script)
    return {
      file,
      line,
      form,
      script: node.getText(sourceFile),
      literals: [],
      dynamic: true,
      callee,
      git: false,
      execParameter: false,
      unparsed: true,
    }
  const { literals, dynamic } = scriptParts(script)
  return {
    file,
    line,
    form,
    script: script.getText(sourceFile),
    literals,
    dynamic,
    callee,
    ...(label === undefined ? {} : { label }),
    git: literals.some((literal) => GIT_COMMAND.test(literal)),
    execParameter: callee === 'exec(' && execIsParameter(node),
  }
}

/** Every shell invocation in `source`: a `sh`/`bash` argv with a `-c` flag, a
 * sandbox `{ cmd: 'sh', args: ['-c', …] }` object, or a `Bun.$` template. */
function shellSites(file: string, source: string): ShellSite[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const sites: ShellSite[] = []
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const program = stringValue(node.elements[0])
      if (program !== undefined && SHELLS.has(program)) {
        for (let index = 1; index < node.elements.length; index++) {
          const option = stringValue(node.elements[index])
          if (option === undefined) {
            sites.push(
              site(
                file,
                sourceFile,
                node,
                'array',
                undefined,
                undefined,
                calleeOf(node, sourceFile),
              ),
            )
            break
          }
          if (SHELL_FLAG.test(option)) {
            sites.push(
              site(
                file,
                sourceFile,
                node,
                'array',
                node.elements[index + 1],
                stringValue(node.elements[index + 2]),
                calleeOf(node, sourceFile),
              ),
            )
            break
          }
        }
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      const property = (name: string) =>
        node.properties.find(
          (entry): entry is ts.PropertyAssignment =>
            ts.isPropertyAssignment(entry) && entry.name.getText(sourceFile) === name,
        )
      const cmd = stringValue(property('cmd')?.initializer)
      if (cmd !== undefined && SHELLS.has(cmd)) {
        const args = property('args')?.initializer
        const elements = args && ts.isArrayLiteralExpression(args) ? args.elements : undefined
        const flag = elements?.findIndex((element) => SHELL_FLAG.test(stringValue(element) ?? ''))
        sites.push(
          site(
            file,
            sourceFile,
            node,
            'object',
            elements && flag !== undefined && flag >= 0 ? elements[flag + 1] : undefined,
            elements && flag !== undefined && flag >= 0
              ? stringValue(elements[flag + 2])
              : undefined,
            calleeOf(node, sourceFile),
          ),
        )
      }
    } else if (ts.isTaggedTemplateExpression(node) && node.tag.getText(sourceFile) === 'Bun.$') {
      sites.push(site(file, sourceFile, node, 'tagged', node.template, undefined, 'Bun.$'))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

/**
 * Host shell scripts that run Git. Each runs through an injected `Exec`, which
 * the hosted dispatcher wraps with `shippedGitExec`, so the shell finds the
 * shipped Git's launcher on `PATH`. Keyed by file and `$0` label (or script).
 */
const GIT_SHELL_INVENTORY = [
  // RestackDeps.exec via `run(deps, …)`: pack-objects into the replay pack.
  'kernel/replay-retention.ts retain-replay',
  // RestackDeps.exec via `run(deps, …)`: unpack-objects / index-pack (two literals).
  'kernel/replay-retention.ts restore-replay',
  // RestackDeps.exec: hash-object of a durable replayed commit.
  'kernel/reconcile-restack.ts printf %s … | git hash-object -t commit -w --stdin',
  // `input.exec`, the forge kernelExec or deps.exec from recoverLostCandidate.
  'ports/workspace/commit-preservation.ts restore-replay',
]
const GIT_SHELL_LITERALS = 5

/** Shell sites whose script is a variable. They run agent, operator and
 * verify commands in build workspaces, never kernel dispatcher Git. */
const DYNAMIC_SHELL_ALLOWLIST: Record<string, string> = {
  'ports/workspace/git-worktree.ts command': 'operator command in a local workspace',
  'ports/workspace/git-worktree.ts request.command': 'agent command in a local workspace',
  'ports/workspace/fake.ts this.sandboxSetupCommand': 'fake sandbox setup for tests',
  'ports/workspace/fake.ts request.command': 'fake sandbox command for tests',
  'processes/build-runner.ts setup': 'repository setup command in the build workspace',
  'processes/build-runner.ts command': 'configured verify/finalize command in the build workspace',
}

/** Sandbox-side scripts that name Git. They run inside the Vercel Sandbox VM
 * with the sandbox's own Git, so they are not routed; listed so a change shows. */
const SANDBOX_GIT_SHELLS: string[] = []

/** A site's identity: its `$0` label, else its literal text, else its source. */
const key = (entry: ShellSite) =>
  `${entry.file} ${entry.label ?? (entry.dynamic ? entry.script : entry.literals.join(' / '))}`

function violations(sites: ShellSite[], options: { inventory?: boolean } = {}): string[] {
  const found: string[] = []
  const at = (entry: ShellSite) => `${entry.file}:${entry.line}`
  const routed = new Set<string>()
  for (const entry of sites) {
    if (entry.unparsed) {
      found.push(`${at(entry)}: unparsed shell site ${entry.script}`)
      continue
    }
    if (entry.form === 'tagged') {
      found.push(`${at(entry)}: Bun.$ shell; run shell commands through an injected Exec`)
      continue
    }
    if (entry.form === 'object') {
      if (entry.file !== SANDBOX_FILE)
        found.push(`${at(entry)}: sandbox command object outside ${SANDBOX_FILE}`)
      else if (entry.git && !SANDBOX_GIT_SHELLS.includes(key(entry)))
        found.push(`${at(entry)}: sandbox Git shell ${key(entry)} is not in SANDBOX_GIT_SHELLS`)
      continue
    }
    if (entry.git) {
      const injected =
        ROUTED_CALLEE.test(entry.callee) && (entry.callee !== 'exec(' || entry.execParameter)
      if (!injected)
        found.push(
          `${at(entry)}: shell-wrapped Git runs through ${entry.callee}; a new shell-wrapped Git call must run through an injected Exec (deps.exec, input.exec, forge kernelExec) so the hosted dispatcher's shim routes it, then be added to GIT_SHELL_INVENTORY`,
        )
      else if (!GIT_SHELL_INVENTORY.includes(key(entry)))
        found.push(
          `${at(entry)}: shell-wrapped Git ${key(entry)} is not in GIT_SHELL_INVENTORY; confirm it runs through an injected Exec and add it`,
        )
      routed.add(key(entry))
    } else if (entry.dynamic && DYNAMIC_SHELL_ALLOWLIST[key(entry)] === undefined)
      found.push(
        `${at(entry)}: shell site runs a dynamic script ${entry.script}; review that it carries no kernel Git and add it to DYNAMIC_SHELL_ALLOWLIST`,
      )
  }
  if (options.inventory)
    for (const entry of GIT_SHELL_INVENTORY)
      if (!routed.has(entry)) found.push(`inventoried Git shell ${entry} was not found`)
  return found
}

async function sources(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sources(path)))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

async function treeSites(): Promise<ShellSite[]> {
  const sites: ShellSite[] = []
  for (const directory of SCANNED)
    for (const path of await sources(join(src, directory)))
      sites.push(...shellSites(relative(src, path), await readFile(path, 'utf8')))
  return sites
}

describe('kernel Git in shells', () => {
  test('every shell site in the dispatcher trees is routed, inventoried or allowlisted', async () => {
    const sites = await treeSites()
    expect(violations(sites, { inventory: true })).toEqual([])
    const git = sites.filter((entry) => entry.git && entry.form === 'array')
    expect(git.flatMap((entry) => entry.literals.filter((l) => GIT_COMMAND.test(l))).length).toBe(
      GIT_SHELL_LITERALS,
    )
    expect(new Set(git.map(key))).toEqual(new Set(GIT_SHELL_INVENTORY))
  })

  test.each([
    ['unrouted with no operator', "Bun.spawn(['sh', '-c', 'git status'])", 'Bun.spawn('],
    [
      'routed but not inventoried',
      "await deps.exec(['bash', '-c', 'cd x; git fetch'], {})",
      'GIT_SHELL_INVENTORY',
    ],
    ['an unrouted login shell', "spawnExec(['sh', '-lc', 'git log'], {})", 'spawnExec('],
    ['a new dynamic site', "Bun.spawn(['sh', '-c', userCommand])", 'DYNAMIC_SHELL_ALLOWLIST'],
    ['a tagged template shell', 'await Bun.$`git status`', 'Bun.$'],
    ['a sandbox object elsewhere', "run(sandbox, { cmd: 'sh', args: ['-c', 'true'] })", 'outside'],
    ['an unparsed shell argv', "deps.exec(['sh', ...flags, 'git status'], {})", 'unparsed'],
  ])('flags %s', (_name, source, message) => {
    const found = violations(shellSites('kernel/fixture.ts', source))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain(message)
  })

  test('ignores non-Git literal scripts and Git outside shell sites', () => {
    const source = [
      "run(deps, ['sh', '-c', 'wc -c < \"$1\"', 'pack-size', p])",
      'throw new Error(`reconcile git $' + '{args} failed`)',
      "deps.exec(['git', 'status'], {})",
    ].join('\n')
    const sites = shellSites('kernel/fixture.ts', source)
    expect(sites).toHaveLength(1)
    expect(sites[0]).toMatchObject({ git: false, dynamic: false, label: 'pack-size' })
    expect(violations(sites)).toEqual([])
  })
})
