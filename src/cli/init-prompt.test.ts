import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { createProcessInitPrompter, INIT_PLUGIN_HELP, type InitPromptQuestion } from './init-prompt'

function streams(inputTty: boolean, outputTty: boolean) {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean
    isRaw?: boolean
    setRawMode?: (raw: boolean) => PassThrough
  }
  const output = new PassThrough() as PassThrough & { isTTY?: boolean }
  input.isTTY = inputTty
  input.isRaw = false
  input.setRawMode = (raw) => {
    input.isRaw = raw
    return input
  }
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

async function startSelect(
  io: ReturnType<typeof streams>,
  controller?: AbortController,
): Promise<{
  prompter: NonNullable<ReturnType<typeof createProcessInitPrompter>>
  selected: Promise<'file' | 'linear'>
}> {
  const prompter = createProcessInitPrompter(io.input, io.output, controller?.signal)!
  const selected = prompter.select(question)
  await Bun.sleep(2)
  return { prompter, selected }
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

  test('Enter accepts the highlighted default and renders option help inline', async () => {
    const io = streams(true, true)
    const { prompter, selected } = await startSelect(io)
    io.input.write('\x1b[B')
    await Bun.sleep(2)
    io.input.write('\x1b[A\r')

    await expect(selected).resolves.toBe('file')
    const rendered = io.rendered()
    expect(rendered).toContain('Set up Autobuild')
    expect(rendered).toContain(INIT_PLUGIN_HELP)
    expect(rendered).toMatch(/Local file tracker[^\n]*No account needed\./)
    expect(rendered).toMatch(/Linear[^\n]*Uses LINEAR_API_KEY\./)
    expect(rendered).not.toContain('1)')
    expect(io.input.isRaw).toBe(false)
    prompter.close?.()
    io.input.end()
  })

  test('arrow keys select options while numeric typing is ignored', async () => {
    const io = streams(true, true)
    const { prompter, selected } = await startSelect(io)
    let settled = false
    void selected.finally(() => {
      settled = true
    })

    io.input.write('2')
    await Bun.sleep(5)
    expect(settled).toBe(false)
    io.input.write('\x1b[B')
    io.input.write('\r')

    await expect(selected).resolves.toBe('linear')
    expect(io.rendered()).not.toContain('Invalid selection')
    prompter.close?.()
    io.input.end()
  })

  test('submitted questions stay collapsed while the next question is active', async () => {
    const io = streams(true, true)
    const prompter = createProcessInitPrompter(io.input, io.output)!
    const first = prompter.select(question)
    await Bun.sleep(2)
    io.input.write('\x1b[B\r')
    await expect(first).resolves.toBe('linear')

    const second = prompter.select({
      message: 'Choose a workspace provider',
      help: INIT_PLUGIN_HELP,
      choices: [
        {
          value: 'git-worktree',
          label: 'Git worktree',
          help: 'No infrastructure required.',
        },
      ],
      defaultValue: 'git-worktree',
    })
    await Bun.sleep(2)
    const renderedWhileActive = io.rendered()
    expect(renderedWhileActive).toContain('Choose a ticket source')
    expect(renderedWhileActive).toContain('Linear')
    expect(renderedWhileActive).toContain('Choose a workspace provider')
    io.input.write('\r')
    await expect(second).resolves.toBe('git-worktree')
    prompter.close?.()
    io.input.end()
  })

  test('Ctrl+C and an AbortSignal reject with one stable cancellation error', async () => {
    for (const kind of ['keypress', 'signal'] as const) {
      const io = streams(true, true)
      const controller = new AbortController()
      const { prompter, selected } = await startSelect(io, controller)
      if (kind === 'keypress') io.input.write('\x03')
      else controller.abort()

      await expect(selected).rejects.toThrow('Init cancelled.')
      expect(io.input.isRaw).toBe(false)
      expect(io.rendered()).not.toContain('Error:')
      prompter.close?.()
      io.input.end()
    }
  })

  test('the completed TTY report uses a summary and a distinct next-steps note', () => {
    const io = streams(true, true)
    const prompter = createProcessInitPrompter(io.input, io.output)!
    prompter.present?.({
      config: 'written',
      skillCounts: { installed: 10, unchanged: 0, kept: 1, overwritten: 1 },
      attention: ['ab-plan: kept', 'ab-guide: overwritten'],
      nextSteps: [
        'Ask your coding agent to change autobuild.toml.',
        'Linear: replace placeholders.',
        'Pi: authenticate providers.',
      ],
    })
    const rendered = io.rendered()
    expect(rendered).toContain('autobuild.toml: written')
    expect(rendered).toContain('10 installed')
    expect(rendered).toContain('ab-plan: kept')
    expect(rendered).toContain('Next steps')
    expect(rendered).toContain('Ask your coding agent to change autobuild.toml.')
    expect(rendered).toContain('Linear: replace placeholders.')
    expect(rendered).toContain('Autobuild is ready.')
    io.input.end()
  })
})
