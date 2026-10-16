import { expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import { humanActor } from '../events/envelope'
import { CONFIG_TOML, happyHandlers, makeHarness, readyTicket, writeFileIn } from './harness'

for (const table of ['verify', 'finalize'] as const) {
  for (const change of ['add', 'remove', 'rename']) {
    for (const kind of ['agent', 'check']) {
      test(`pinned ${table} ${kind} survives base ${change} without replacement execution`, async () => {
        const extra = (name: string) => `
[${table}.${name}]
kind = "${kind}"
${kind === 'check' ? 'command = "test"' : 'skill = "extra"'}
${table === 'verify' && change === 'add' ? 'paths = ["rate-limit.txt"]' : ''}
`
        const withStep = (name: string) => {
          if (table === 'verify') {
            return (
              CONFIG_TOML.replace('steps = ["unit"]', `steps = ["unit", "${name}"]`) + extra(name)
            )
          }
          return `${CONFIG_TOML}\n[finalize]\nsteps = ["${name}"]\n${extra(name)}`
        }
        const original = change === 'add' ? CONFIG_TOML : withStep('original')
        let live = parseConfig(original)
        const handlers = happyHandlers()
        handlers.extra = async (cli) => {
          if (table === 'finalize') return
          await cli.run(['context'])
          const notes = await writeFileIn(cli.ws, '.ab/extra.md', 'Passed.')
          await cli.run(['verdict', 'pass', '--notes', notes])
        }
        const h = await makeHarness({
          handlers,
          configToml: original,
          pinnedConfig: true,
          getConfig: () => live,
          tickets: [readyTicket('T-pin')],
          gatePresence: 'absent',
        })
        try {
          await h.dispatcher.tick()
          const state = await h.runLatest()
          expect(state.pr).toBeDefined()
          expect(h.cliErrors).toEqual([])
          const baseline = h.launched.length
          const slug = h.launched[0]!.slug
          const before = await h.events(slug)
          // Only the dispatcher's deployment snapshot changes; runner reads its durable pin.
          live = parseConfig(change === 'remove' ? CONFIG_TOML : withStep('replacement'))
          await h.store.append(slug, {
            actor: humanActor('operator'),
            type: 'build.auto-merge-requested',
            payload: {},
          })
          h.forge.setPrState(state.pr!.number, { state: 'open', mergeable: true })
          h.forge.setPrHeadSha(state.pr!.number, state.pr!.headSha)
          await h.dispatcher.tick({ resumeCurrent: true, acceptNewWork: false })
          expect(h.forge.squashMergeCalls).toHaveLength(1)
          await h.dispatcher.tick({ resumeCurrent: true, acceptNewWork: false })
          expect(h.launched).toHaveLength(baseline)
          const after = await h.events(slug)
          expect(
            after.filter((e) => e.type === 'verify.started' || e.type === 'finalize.step-started')
              .length,
          ).toBe(
            before.filter((e) => e.type === 'verify.started' || e.type === 'finalize.step-started')
              .length,
          )
          expect(after.at(-1)?.type).toBe('build.completed')
        } finally {
          await h.cleanup()
        }
      }, 30_000)
    }
  }
}
