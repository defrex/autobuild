import { intro, isCancel, log, note, outro, select } from '@clack/prompts'
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

export type InitSkillSummaryAction = 'installed' | 'kept' | 'unchanged' | 'overwritten'

export interface InitPresentation {
  config: 'written' | 'skipped'
  skillCounts: Record<InitSkillSummaryAction, number>
  attention: string[]
  nextSteps: string[]
}

/** Narrow prompt seam: init owns choices and report content; production owns terminal I/O. */
export interface InitPrompter {
  select<T extends string>(question: InitPromptQuestion<T>): Promise<T>
  present?(presentation: InitPresentation): void
  close?(): void
}

export class InitCancelledError extends Error {
  constructor() {
    super('Init cancelled.')
    this.name = 'InitCancelledError'
  }
}

class ClackInitPrompter implements InitPrompter {
  private started = false
  private readonly renderedHelp = new Set<string>()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly signal?: AbortSignal,
  ) {}

  private start(): void {
    if (this.started) return
    intro('Set up Autobuild', { input: this.input, output: this.output })
    this.started = true
  }

  async select<T extends string>(question: InitPromptQuestion<T>): Promise<T> {
    const defaultChoice = question.choices.find((choice) => choice.value === question.defaultValue)
    if (question.choices.length === 0 || defaultChoice === undefined) {
      throw new Error(`init prompt "${question.message}" has an invalid default`)
    }
    if (this.signal?.aborted === true) throw new InitCancelledError()

    this.start()
    if (question.help !== '' && !this.renderedHelp.has(question.help)) {
      log.info(question.help, { input: this.input, output: this.output })
      this.renderedHelp.add(question.help)
    }

    const answer = await select<string>({
      message: question.message,
      options: question.choices.map((choice) => ({
        value: String(choice.value),
        label: choice.label,
        hint: choice.help,
      })),
      initialValue: question.defaultValue,
      input: this.input,
      output: this.output,
      ...(this.signal !== undefined ? { signal: this.signal } : {}),
    })
    if (isCancel(answer)) throw new InitCancelledError()
    // Every selectable value came directly from the typed choices above.
    return answer as T
  }

  present(presentation: InitPresentation): void {
    this.start()
    log.success(`autobuild.toml: ${presentation.config}`, {
      input: this.input,
      output: this.output,
    })
    const { installed, unchanged, kept, overwritten } = presentation.skillCounts
    log.info(
      `Skills: ${installed} installed, ${unchanged} unchanged, ${kept} kept, ${overwritten} overwritten`,
      { input: this.input, output: this.output },
    )
    for (const line of presentation.attention) {
      log.warn(line, { input: this.input, output: this.output })
    }
    if (presentation.nextSteps.length > 0) {
      note(presentation.nextSteps.join('\n'), 'Next steps', {
        input: this.input,
        output: this.output,
      })
    }
    outro('Autobuild is ready.', { input: this.input, output: this.output })
  }

  close(): void {
    // Clack restores terminal input state as each prompt settles. The seam is
    // retained so injected adapters and future presenter resources can close.
  }
}

/**
 * Production TTY gate. Both streams must be interactive; redirects and pipes
 * use the deterministic plain renderer and never invoke Clack.
 */
export function createProcessInitPrompter(
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable & { isTTY?: boolean } = process.stdout,
  signal?: AbortSignal,
): InitPrompter | undefined {
  if (input.isTTY !== true || output.isTTY !== true) return undefined
  return new ClackInitPrompter(input, output, signal)
}
