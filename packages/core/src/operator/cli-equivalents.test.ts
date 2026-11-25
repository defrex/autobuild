import { describe, expect, test } from 'bun:test'
import { HELP_CATALOG } from '../cli/help'
import { OPERATOR_TOOL_ANNOTATIONS } from './annotations'
import {
  CLI_COMMAND_ALIASES,
  CLI_WITHOUT_TOOL,
  cliMentions,
  OPERATOR_TOOL_CLI,
  renderCliMapping,
} from './cli-equivalents'
import { TOOLS } from './registry'

const declared = Object.values(OPERATOR_TOOL_CLI).flatMap((declaration) =>
  'cli' in declaration ? declaration.cli.map((entry) => entry.command) : [],
)
const classified = CLI_WITHOUT_TOOL.map((entry) => entry.command)

function documented(command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escaped}(?=[ \\[<\`'\\n]|$)`)
  return HELP_CATALOG.some((entry) => pattern.test(entry.detail) || `ab ${entry.name}` === command)
}

describe('the CLI-equivalence table', () => {
  test('every registry tool declares its CLI forms or why it has none', () => {
    for (const tool of TOOLS) expect(OPERATOR_TOOL_CLI[tool.name], tool.name).toBeDefined()
    expect(Object.keys(OPERATOR_TOOL_CLI).sort()).toEqual(
      Object.keys(OPERATOR_TOOL_ANNOTATIONS).sort(),
    )
  })

  test('every declared or classified command exists in the help catalog', () => {
    for (const command of [...declared, ...classified, ...Object.keys(CLI_COMMAND_ALIASES)])
      expect(documented(command) || command in CLI_COMMAND_ALIASES, command).toBe(true)
  })

  test('every catalog command is covered, and none is both mapped and tool-less', () => {
    const known = [...declared, ...classified]
    for (const entry of HELP_CATALOG) {
      const command = `ab ${entry.name}`
      expect(
        known.some((k) => k === command || k.startsWith(`${command} `)),
        command,
      ).toBe(true)
    }
    for (const command of classified) expect(declared, command).not.toContain(command)
  })

  test('mentions resolve to the longest known command and render one line each', () => {
    const text = [
      'Run `ab ticket create "x" --body f`, then ab abort my-build.',
      'Inside a phase use ab done; set up with ab init. Prose: ab over the top.',
      'Again: bun ab pause slug and ab ticket create.',
      'Families: ab ticket … and ab land slug.',
    ].join('\n')
    const commands = cliMentions(text)
    expect(commands).toEqual([
      'ab ticket create',
      'ab abort',
      'ab done',
      'ab init',
      'ab pause',
      'ab ticket',
      'ab merge',
    ])
    expect(renderCliMapping(commands)).toEqual([
      '- `ab ticket create` → `tickets.create` (body as text, not a file)',
      '- `ab abort` → `builds.control` (action: "abort")',
      '- `ab done` → no tool: build sessions only; it does not apply to you',
      '- `ab init` → no tool: run it inside the sandbox with `sandbox.exec` (no store credentials there)',
      '- `ab pause` → `builds.control` (action: "pause") or `repository.bulk_control` (--all; action: "pause")',
      '- `ab ticket …` → the `tickets.*` tools',
      '- `ab merge` → `builds.control` (action: "merge")',
    ])
  })
})
