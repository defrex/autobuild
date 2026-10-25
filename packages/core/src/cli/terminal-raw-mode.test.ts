import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distributionPath } from '../distribution'

const mkdtemp = ownTempDirectories(afterEach)

test('shared PTY survives retired Bun exits across presentation lifetimes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ab-raw-'))
  const script = `
import os, pty, subprocess, sys, termios, time, select
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
children = []
root, bun = sys.argv[1:]
def wait(predicate):
 deadline = time.monotonic() + 5
 while not predicate():
  if time.monotonic() > deadline: raise Exception('PTY deadline; termios='+repr(termios.tcgetattr(slave)))
  time.sleep(.01)
def file(name): return os.path.join(root, name)
def touch(name): open(file(name), 'w').close()
def spawn(name):
 p = subprocess.Popen([bun, file(name+'.ts')], stdin=slave, stdout=master_output, stderr=master_output)
 children.append(p)
 wait(lambda: os.path.exists(file(name+'.ready')))
 return p
def raw():
 return termios.tcgetattr(slave)[3] & (termios.ICANON | termios.ECHO | termios.ISIG) == 0
def cooked():
 flags = termios.ICANON | termios.ECHO | termios.ISIG
 return termios.tcgetattr(slave)[3] & flags == original[3] & flags
def retire(name, p, presenting=True):
 if presenting: wait(raw)
 touch(name+'.exit')
 p.wait(timeout=5)
 assert p.returncode == 0
 if presenting:
  wait(raw)
  os.write(master, b'k')
  wait(lambda: os.path.exists(file('key')))
  os.unlink(file('key'))
 else:
  time.sleep(.35)
  assert cooked(), 'released subscription stole tty'
# Capture all terminal output to check that printable keys were never echoed.
master_output = slave
try:
 old = spawn('old')
 current = spawn('current')
 assert raw()
 retire('old', old)
 # Multiple takeovers, with a predecessor lingering across two of them.
 for index in range(3):
  touch('current.stop')
  wait(lambda: os.path.exists(file('current.stopped')))
  os.unlink(file('current.stopped'))
  assert cooked()
  name = 'retired'+str(index)
  predecessor = spawn(name)
  touch('current.start')
  wait(lambda: os.path.exists(file('current.started')))
  os.unlink(file('current.started'))
  wait(raw)
  if index == 0: lingering = predecessor
  else: retire(name, predecessor)
 retire('retired0', lingering)
 # Release/suspension interval stays cooked even when another Bun exits.
 touch('current.stop')
 wait(lambda: os.path.exists(file('current.stopped')))
 stopped = spawn('stopped')
 retire('stopped', stopped, False)
 # Already-exited predecessor, then resume/restart/rollback-shaped activation.
 touch('current.start')
 wait(lambda: os.path.exists(file('current.started')))
 wait(raw)
 touch('current.exit')
 current.wait(timeout=5)
 time.sleep(.35)
 assert termios.tcgetattr(slave) == original, 'clean exit did not restore original tty'
 output = b''
 while select.select([master], [], [], 0)[0]: output += os.read(master, 65536)
 assert b'k' not in output, repr(output)
 print('raw input repaired; released and stopped tty cooked')
finally:
 for p in children:
  if p.poll() is None: p.kill()
 for p in children: p.wait(timeout=5)
 os.close(master)
 os.close(slave)
`
  try {
    const old = (name: string) => `
import { existsSync, writeFileSync } from 'node:fs'
import { processTerminalInput } from ${JSON.stringify(distributionPath('packages/core/src/cli/terminal.ts'))}
processTerminalInput().start(() => {})()
writeFileSync(${JSON.stringify(join(dir, `${name}.ready`))}, '')
setInterval(() => {
 if (existsSync(${JSON.stringify(join(dir, `${name}.exit`))})) process.exit(0)
}, 10)
`
    for (const name of ['old', 'retired0', 'retired1', 'retired2', 'stopped']) {
      await writeFile(join(dir, `${name}.ts`), old(name))
    }
    await writeFile(
      join(dir, 'current.ts'),
      `
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'

import { processTerminalInput } from ${JSON.stringify(distributionPath('packages/core/src/cli/terminal.ts'))}
const path = ${JSON.stringify(dir)}
const start = () => processTerminalInput().start(event => {
 if (event.type === 'text' && event.text === 'k') writeFileSync(path+'/key', '')
})
let cleanup = start()
writeFileSync(path+'/current.ready', '')
setInterval(() => {
 for (const action of ['stop', 'start', 'exit']) {
  const command = path+'/current.'+action
  if (!existsSync(command)) continue
  unlinkSync(command)
  if (action === 'start') cleanup = start()
  else cleanup()
  if (action === 'exit') process.exit(0)
  writeFileSync(path+'/current.'+(action === 'start' ? 'started' : 'stopped'), '')
 }
}, 10)
`,
    )
    const child = Bun.spawn(['python3', '-c', script, dir, process.execPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain('raw input repaired')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
