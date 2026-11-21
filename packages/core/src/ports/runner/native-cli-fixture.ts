#!/usr/bin/env bun
/** Disk-backed native CLI stand-in. Its private state is outside the workspace. */
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const provider = process.env.AB_NATIVE_FIXTURE_PROVIDER!
const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
if (args.includes('--version')) {
  console.log('1.3.0')
  process.exit(0)
}
const path = flag('--session') ?? join(process.env.AB_NATIVE_FIXTURE_STATE!, 'session.jsonl')
const resuming =
  args.includes('resume') ||
  args.includes('--resume') ||
  args.includes('--session') ||
  args.includes('--conversation')
if (resuming) {
  try {
    await access(path)
  } catch {
    console.error(
      provider === 'antigravity'
        ? `conversation ${flag('--conversation')} not found`
        : 'Session not found',
    )
    process.exit(1)
  }
}
const state: { id: string; memory?: string } = resuming
  ? JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!)
  : { id: flag('--session-id') ?? crypto.randomUUID() }
const save = () => writeFile(path, `${JSON.stringify({ type: 'session', ...state })}\n`)
await save()
const emit = (event: unknown) => console.log(JSON.stringify(event))
const identify = () =>
  emit(
    provider === 'claude'
      ? { type: 'system', subtype: 'init', session_id: state.id }
      : provider === 'antigravity'
        ? { event: 'init', conversation_id: state.id, init: { cwd: process.cwd() } }
        : { type: 'thread.started', thread_id: state.id },
  )
async function prompt(message: string, env: Record<string, string | undefined>): Promise<string> {
  // The start prompt carries the invocation as a quoted, labelled identifier.
  if (!resuming) state.memory = /"([^"]*)"/.exec(message)?.[1] ?? message.split(' ').at(-1)
  await save()
  if (env.AB_NATIVE_FIXTURE_RELEASE !== undefined) {
    while (!(await Bun.file(env.AB_NATIVE_FIXTURE_RELEASE).exists())) await Bun.sleep(5)
  }
  return `${state.memory} ${env.NATIVE_CONTRACT_FRESH ?? ''}`
}
if (provider === 'pi') {
  let env = process.env
  let tokens = 0
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line) as { id: string; type: string; message?: string }
    const response = (data?: unknown) =>
      emit({ id: command.id, command: command.type, type: 'response', success: true, data })
    if (command.type === 'get_state') response({ sessionId: state.id, sessionFile: path })
    else if (command.type === 'get_session_stats')
      response({ tokens: { input: tokens, output: tokens } })
    else if (command.type === 'prompt' && command.message?.startsWith('/autobuild-configure ')) {
      env = JSON.parse(
        Buffer.from(command.message.split(' ')[1]!, 'base64url').toString(),
      ).environment
      response()
    } else if (command.type === 'prompt') {
      response()
      const text = await prompt(command.message!, env)
      tokens++
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
      emit({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      })
      emit({ type: 'agent_settled' })
    } else response()
  }
} else {
  identify()
  // agy takes the prompt as the value after `-p`, guarded by one leading
  // newline when it would otherwise start with `-`.
  const message = provider === 'antigravity' ? flag('-p')!.replace(/^\n(?=-)/, '') : args.at(-1)!
  const text = await prompt(message, process.env)
  if (provider === 'antigravity') {
    emit({
      event: 'step_update',
      step_update: {
        conversation_id: state.id,
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: text,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    emit({
      event: 'result',
      result: {
        conversation_id: state.id,
        status: 'SUCCESS',
        response: text,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
  } else if (provider === 'claude')
    emit({
      type: 'result',
      subtype: 'success',
      session_id: state.id,
      result: text,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  else {
    emit({ type: 'item.completed', item: { type: 'agent_message', text } })
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  }
}
