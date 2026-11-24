import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stringify } from 'smol-toml'
import { localConfigPath, parseLayeredConfig, readLocalConfig } from '../config/local'
import { parseConfigTable } from '../config/load'

/** Explicit checkout-local preference; never opens a store or commands a dispatcher. */
export async function abOperatorDispatcher(opts: {
  targetRepo: string
  value?: string
  json?: boolean
  env: Record<string, string | undefined>
  stdout: (line: string) => void
}): Promise<void> {
  if (opts.value !== undefined && opts.value !== 'human' && opts.value !== 'agent')
    throw new Error('usage: ab operator dispatcher [human|agent] [--json]')
  if (
    opts.value !== undefined &&
    ['AB_BUILD', 'AB_SESSION', 'AB_HARVEST'].some((name) => opts.env[name]?.trim())
  )
    throw new Error(
      'operator dispatcher writes require an operator outside a build or harvest session',
    )
  const file = localConfigPath(opts.targetRepo)
  const local = await readLocalConfig(opts.targetRepo)
  const table = local ? parseConfigTable(local.text, file) : {}
  // Validate the local input itself, including its allowlist, before updating it.
  const committed = {
    text: await Bun.file(join(opts.targetRepo, 'autobuild.toml')).text(),
    source: join(opts.targetRepo, 'autobuild.toml'),
  }
  const validate = (text: string) =>
    parseLayeredConfig({ committed, local: { text, source: file } }, () => {}).config
  const before = validate(local?.text ?? '')
  let dispatcher = before.operator?.dispatcher ?? null
  if (opts.value !== undefined) {
    table.operator = {
      ...(table.operator as Record<string, unknown> | undefined),
      dispatcher: opts.value,
    }
    const candidate = stringify(table)
    dispatcher = validate(candidate).operator?.dispatcher ?? null
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await Bun.write(temporary, candidate)
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  opts.stdout(
    opts.json
      ? JSON.stringify({ dispatcher, file })
      : `Dispatcher preference: ${dispatcher ?? 'unset'} (${file})`,
  )
}
