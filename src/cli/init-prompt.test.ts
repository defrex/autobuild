import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import {
  createProcessInitPrompter,
  INIT_PLUGIN_HELP,
  type InitPromptQuestion,
} from './init-prompt'

function streams(inputTty: boolean, outputTty: boolean) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean }
  const output = new PassThrough() as PassThrough & { isTTY?: boolean }
  input.isTTY = inputTty
  output.isTTY = outputTty
  let rendered = ''
  output.on('data', (chunk) => {
    rendered += chunk.toString()
  })
  return { input, output, rendered: () => rendered }
}

const question: InitPromptQuestion<'file' | 'linear'> = {
  message: 'Choose a ticket source',
  help: INIT_PLUGIN_HELP,
  defaultValue: 'file',
  choices: [
    { value: 'file', label: 'Local file tracker', help: 'No account needed.' },
    { value: 'linear', label: 'Linear', help: 'Uses LINEAR_API_KEY.' },
  ],
}

describe('init prompt adapter', () => {
  test.each([
    [false, false],
    [true, false],
    [false, true],
  ])('is absent unless stdin=%s and stdout=%s are both TTYs', (stdin, stdout) => {
    const io = streams(stdin, stdout)
    expect(createProcessInitPrompter(io.input, io.output)).toBeUndefined()
  })

  test('Enter accepts the displayed first/default option and renders plugin help', async () => {
    const io = streams(true, true)
    const prompter = createProcessInitPrompter(io.input, io.output)!
    const selected = prompter.select(question)
    io.input.write('\n')

    await expect(selected).resolves.toBe('file')
    expect(io.rendered()).toContain('1) Local file tracker [file] (default)')
    expect(io.rendered()).toContain(INIT_PLUGIN_HELP)
    expect(io.rendered()).toContain('Select [1]:')
    prompter.close?.()
    io.input.end()
  })

  test('accepts a number or value and retries invalid input with feedback', async () => {
    const io = streams(true, true)
    const prompter = createProcessInitPrompter(io.input, io.output)!
    try {
      const selected = prompter.select(question)
      io.input.write('wat\n')
      await Bun.sleep(5)
      io.input.write('2\n')

      await expect(selected).resolves.toBe('linear')
      expect(io.rendered()).toContain('Invalid selection "wat"')
    } finally {
      prompter.close?.()
      io.input.end()
    }
  })

  test('fails clearly when input closes before an answer', async () => {
    const io = streams(true, true)
    const prompter = createProcessInitPrompter(io.input, io.output)!
    const selected = prompter.select(question)
    io.input.end()

    await expect(selected).rejects.toThrow(/closed before .* was answered/)
    prompter.close?.()
  })
})
