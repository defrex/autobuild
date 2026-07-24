import { createInterface, type Interface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'

export const INIT_PLUGIN_HELP =
  'Custom adapter implementations can be swapped in through plugins. They are straightforward to build with an agent; see .agents/skills/ab-guide/references/plugin-authoring.md.'

export interface InitPromptChoice<T extends string = string> {
  value: T
  label: string
  help: string
}

export interface InitPromptQuestion<T extends string = string> {
  message: string
  help: string
  choices: readonly InitPromptChoice<T>[]
  defaultValue: T
}

/** Narrow prompt seam: init owns choices; production owns terminal I/O. */
export interface InitPrompter {
  select<T extends string>(question: InitPromptQuestion<T>): Promise<T>
  close?(): void
}

class ReadlineInitPrompter implements InitPrompter {
  private readline: Interface | undefined
  private readonly inputEnded: Promise<void>

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    this.inputEnded = new Promise((resolve) => {
      if (input.readableEnded || input.destroyed) resolve()
      else {
        input.once('end', resolve)
        input.once('close', resolve)
      }
    })
  }

  private interface(): Interface {
    this.readline ??= createInterface({
      input: this.input,
      output: this.output,
      terminal: false,
    })
    return this.readline
  }

  async select<T extends string>(question: InitPromptQuestion<T>): Promise<T> {
    const defaultIndex = question.choices.findIndex(
      (choice) => choice.value === question.defaultValue,
    )
    if (question.choices.length === 0 || defaultIndex === -1) {
      throw new Error(`init prompt "${question.message}" has an invalid default`)
    }

    this.output.write(`\n${question.message}\n`)
    question.choices.forEach((choice, index) => {
      const marker = index === defaultIndex ? ' (default)' : ''
      this.output.write(`  ${index + 1}) ${choice.label} [${choice.value}]${marker}\n`)
      this.output.write(`     ${choice.help}\n`)
    })
    this.output.write(`  ${question.help}\n`)

    while (true) {
      let answer: string
      try {
        const result = await Promise.race([
          this.interface()
            .question(`Select [${defaultIndex + 1}]: `)
            .then((value) => ({ kind: 'answer' as const, value })),
          this.inputEnded.then(() => ({ kind: 'closed' as const })),
        ])
        if (result.kind === 'closed') {
          throw new Error('input reached EOF')
        }
        answer = result.value
      } catch (error) {
        throw new Error(
          `init prompt closed before "${question.message}" was answered: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      const normalized = answer.trim()
      if (normalized === '') return question.defaultValue

      const numeric = Number(normalized)
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= question.choices.length) {
        return question.choices[numeric - 1]!.value
      }
      const byValue = question.choices.find(
        (choice) => choice.value.toLowerCase() === normalized.toLowerCase(),
      )
      if (byValue !== undefined) return byValue.value

      this.output.write(
        `Invalid selection "${normalized}". Enter 1-${question.choices.length} or one of: ${question.choices
          .map((choice) => choice.value)
          .join(', ')}.\n`,
      )
    }
  }

  close(): void {
    this.readline?.close()
    this.readline = undefined
  }
}

/**
 * Production TTY gate. Both streams must be interactive; redirects and pipes
 * retain the historical silent init behavior.
 */
export function createProcessInitPrompter(
  input: (Readable & { isTTY?: boolean }) = process.stdin,
  output: (Writable & { isTTY?: boolean }) = process.stdout,
): InitPrompter | undefined {
  if (input.isTTY !== true || output.isTTY !== true) return undefined
  return new ReadlineInitPrompter(input, output)
}
