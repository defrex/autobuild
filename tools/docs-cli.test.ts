import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HELP_CATALOG } from '../packages/core/src/cli/help'

test('CLI inventory covers the help catalog exactly once in the specified groups', async () => {
  const source = await readFile(join(import.meta.dir, '../docs/cli.md'), 'utf8')
  const [, human, agent] = source.split(/## For (?:you|your operator agent)\n/)
  const commands = (section: string) =>
    [...section.matchAll(/^- `([a-z]+)` —/gm)].map((match) => match[1]!)
  const humanCommands = commands(human!)
  const agentCommands = commands(agent!)
  expect(humanCommands.sort()).toEqual([
    'connect',
    'disconnect',
    'dispatch',
    'init',
    'secrets',
    'upgrade',
  ])
  expect([...humanCommands, ...agentCommands].sort()).toEqual(
    HELP_CATALOG.map((entry) => entry.name).sort(),
  )
  expect(agentCommands.sort()).toEqual(
    HELP_CATALOG.map((entry) => entry.name)
      .filter((name) => !humanCommands.includes(name))
      .sort(),
  )
})
