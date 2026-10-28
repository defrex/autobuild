import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { mkdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distributionPath } from '../distribution'
import { openLocalStore } from '../store/local/store'
import { GENERATION_SIGNALS } from './dispatch-launch-contract'

const mkdtemp = ownTempDirectories(afterEach)

for (const signal of GENERATION_SIGNALS)
  test(`production launcher drains ${signal} and records the original signal`, async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'ab-launch-signals-'))
    const storePath = join(checkout, '.autobuild', 'store')
    const store = openLocalStore(storePath)
    await mkdir(join(checkout, 'tickets/ready'), { recursive: true })
    await writeFile(
      join(checkout, 'autobuild.toml'),
      'forge = "local-git"\n[roles.default]\nruntime = "claude"\n[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
    )
    const child = Bun.spawn(
      [
        process.execPath,
        distributionPath('bin/ab.ts'),
        'dispatch',
        '--plain',
        '--interval',
        '0.02',
        '--store',
        storePath,
      ],
      {
        cwd: checkout,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AB_DISPATCH_GENERATION: JSON.stringify({
            version: 999,
            runtimeRoot: '/wrong',
            checkout: '/wrong',
          }),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const stdout = new Response(child.stdout).text(),
      stderr = new Response(child.stderr).text()
    try {
      const deadline = Date.now() + 30000
      for (;;) {
        const repo = await store.getRepo(checkout)
        if (
          repo &&
          (await store.getRepoEvents(checkout)).some(
            (e) => e.type === 'dispatcher.runtime-recorded',
          )
        )
          break
        if (child.exitCode !== null) throw new Error(await stderr)
        if (Date.now() > deadline) throw new Error('dispatcher did not start')
        await Bun.sleep(20)
      }
      child.kill(signal)
      await child.exited
      const events = await store.getRepoEvents(checkout)
      expect(events.find((e) => e.type === 'dispatcher.run-stopped')?.payload).toMatchObject({
        outcome: 'normal',
        signal,
      })
      if (signal === 'SIGINT') expect(child.exitCode).toBe(0)
      else expect(child.signalCode).toBe(signal)
      expect(await stderr).toBe('')
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGINT')
        await child.exited
      }
      await stdout
      await store.close()
      await rm(checkout, { recursive: true, force: true })
    }
  }, 45000)

test('public inherited markers cannot bypass routing; hot renderer keeps the direct seam', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'ab-launch-routing-'))
  try {
    const code = `import {runBinary} from ${JSON.stringify(distributionPath('packages/core/src/cli/binary.ts'))}; const code=await runBinary(['dispatch'],()=>()=>[]); if(process.env.AB_DISPATCH_GENERATION) throw new Error('marker leaked'); process.exit(code);`
    const child = Bun.spawn([process.execPath, '--eval', code], {
      cwd: checkout,
      env: { PATH: process.env.PATH, AB_DISPATCH_GENERATION: 'malformed' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('autobuild.toml')
    await expect(access(join(checkout, '.autobuild/runtime'))).rejects.toThrow()
    const invalid = Bun.spawn(
      [process.execPath, distributionPath('bin/ab-dispatch-generation.ts'), '--version'],
      {
        env: { PATH: process.env.PATH, AB_DISPATCH_GENERATION: 'malformed' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(await invalid.exited).toBe(82)
    expect(await new Response(invalid.stderr).text()).not.toBe('')
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
})

test('dispatch help bypasses resident classification without preparing a cache', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-dispatch-help-'))
  try {
    const child = Bun.spawn(
      [process.execPath, distributionPath('bin/ab.ts'), 'dispatch', '--help'],
      {
        cwd,
        env: { PATH: process.env.PATH },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(0)
    expect(stdout).toContain('ab dispatch — Run the repository build dispatcher')
    expect(stderr).toBe('')
    await expect(access(join(cwd, '.autobuild/runtime'))).rejects.toThrow()
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('real launcher returns the PTY to the shell on Ctrl-Z and fg resumes the dashboard', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-launch-job-'))
  await mkdir(join(cwd, 'tickets/ready'), { recursive: true })
  await writeFile(
    join(cwd, 'autobuild.toml'),
    'forge = "local-git"\n[roles.default]\nruntime = "claude"\n[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
  )
  const script = `
import os, pty, select, sys, time, shlex, signal, termios
pid, fd = pty.fork()
if pid == 0:
 os.chdir(sys.argv[1])
 os.environ['PS1'] = 'SHELL_READY> '
 os.environ['TERM'] = 'xterm-256color'
 os.execlp('bash', 'bash', '--noprofile', '--norc', '-i')
output = b''
def until(marker, timeout=40):
 global output
 deadline = time.monotonic() + timeout
 while marker not in output:
  if time.monotonic() > deadline: raise Exception('missing '+repr(marker)+' in '+repr(output[-3000:]))
  if select.select([fd], [], [], .05)[0]: output += os.read(fd, 65536)
try:
 until(b'SHELL_READY> ')
 def mode(raw):
  global output
  if raw:
   time.sleep(.35)
   flags = termios.tcgetattr(fd)[3]
   assert flags & (termios.ICANON | termios.ECHO | termios.ISIG) == 0, repr(flags)
  else:
   # Bash readline itself disables ICANON/ECHO at the prompt. Inspect the
   # shell's restored settings in a foreground command instead.
   output = b''
   probe = "import termios,time; time.sleep(.35); mask=termios.ICANON|termios.ECHO|termios.ISIG; flags=termios.tcgetattr(0)[3]; assert flags & mask == mask, repr(flags); print('COOKED_'+'OK')"
   os.write(fd, (shlex.join(['python3', '-c', probe])+'\\n').encode())
   until(b'COOKED_OK')
   until(b'SHELL_READY> ')
 output = b''
 command = shlex.join(sys.argv[2:])
 os.write(fd, (command+'\\n').encode())
 until(b'\\x1b[?1049h')
 time.sleep(.5)
 def children(parent):
  with open('/proc/'+str(parent)+'/task/'+str(parent)+'/children') as f: return [int(p) for p in f.read().split()]
 launcher = children(pid)[0]
 generation = children(launcher)[0]
 kernel = children(generation)[0]
 output = b''
 os.write(fd, b'\\x1a')
 until(b'SHELL_READY> ', 5)
 assert b'Stopped' in output, output
 mode(False)
 with open('/proc/'+str(kernel)+'/stat') as f: assert f.read().split(') ')[1][0] != 'T'
 output = b''
 os.write(fd, b'fg\\n')
 until(b'\\x1b[?1049h', 5)
 mode(True)
 output = b''
 os.write(fd, b'\\x03')
 until(b'SHELL_READY> ')
 assert output.count(b'\\x1b[?1049l') == 1, repr(output)
 mode(False)
 # --plain on a TTY never owned an alternate screen.
 output = b''
 os.write(fd, (command+' --plain\\n').encode())
 until(b'Ctrl-C to stop')
 os.write(fd, b'\\x03')
 until(b'SHELL_READY> ')
 assert b'\\x1b[?1049l' not in output, repr(output)
 output = b''
 os.write(fd, (command+'\\n').encode())
 until(b'\\x1b[?1049h')
 time.sleep(.3)
 generation = children(children(pid)[0])[0]
 output = b''
 os.kill(generation, signal.SIGKILL)
 until(b'SHELL_READY> ')
 assert output.count(b'\\x1b[?1049l') == 1, repr(output)
 time.sleep(1)
 print('shell regained control; fg resumed; clean exits preserved terminal frame; crash restored modes')
finally:
 os.write(fd, b'exit\\n')
 os.close(fd)
 os.kill(pid, signal.SIGHUP)
 os.waitpid(pid, 0)
`
  try {
    const child = Bun.spawn(
      [
        'python3',
        '-c',
        script,
        cwd,
        process.execPath,
        distributionPath('bin/ab.ts'),
        'dispatch',
        '--interval',
        '0.05',
      ],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain('shell regained control')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, 90000)

test('an isolated registry installation prepares local launch without a guest asset fetch', async () => {
  const { prepareLaunchRuntime } = await import('./dispatch-launcher')
  const { releasePreparedRuntime } = await import('./dispatch-runtime-use')
  const root = await mkdtemp(join(tmpdir(), 'ab-isolated-launch-'))
  const source = join(
    root,
    'node_modules/.bun/@defrex+autobuild@1.2.3/node_modules/@defrex/autobuild',
  )
  const checkout = join(root, 'consumer')
  try {
    await mkdir(join(source, 'bin/agent'), { recursive: true })
    await mkdir(join(source, 'packages'), { recursive: true })
    await mkdir(checkout)
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name: '@defrex/autobuild', version: '1.2.3', files: ['bin', 'packages'] }),
    )
    await writeFile(join(source, 'bin/ab.ts'), 'console.log("1.2.3")')
    await writeFile(join(source, 'bin/agent/ab'), '#!/bin/sh\n')
    for (const entry of [
      'ab-dispatch-generation.ts',
      'ab-dispatch-kernel.ts',
      'ab-build-runner.ts',
      'ab-harvest-runner.ts',
      'ab-process-group-reaper.ts',
    ])
      await writeFile(join(source, 'bin', entry), 'export {}')
    // The .bun store entry has no owner manifest. This is Bun's argv[1] realpath.
    const runtime = await prepareLaunchRuntime(source, source, checkout)
    expect(runtime.guestArchive).toEqual({ provenance: 'registry', file: 'guest-distribution.tgz' })
    expect(await Bun.file(join(runtime.root, '../guest-distribution.tgz')).exists()).toBe(false)
    releasePreparedRuntime(runtime.root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launcher reader preserves helper incompatibility through active and predecessor failure streaks', async () => {
  const { generationReaderResult, generationReaderFailures } = await import('./dispatch-launcher')
  const messages: string[] = []
  const streak = generationReaderFailures((message) => messages.push(message))
  const diagnostic =
    'incompatible reducer dispatchUpgrade: client version 1, server version 2; reducer version mismatch'
  const failed = (role: 'active' | 'predecessor') => {
    try {
      generationReaderResult(1, '', `${role}: ${diagnostic}`)
    } catch (error) {
      streak.report(role, error)
    }
  }
  // No predecessor: one diagnostic despite repeated probes.
  failed('active')
  failed('active')
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain(diagnostic)
  // Failed predecessor retains the original diagnostic and adds its own once.
  failed('predecessor')
  failed('active')
  failed('predecessor')
  expect(messages).toHaveLength(2)
  expect(messages[1]).toContain(`predecessor: ${diagnostic}`)
  expect(generationReaderResult(0, '{"version":1}', '')).toEqual({ version: 1 })
  streak.clear()
  failed('active')
  expect(messages).toHaveLength(3)
})

test('reader errors stay visible while predecessor conditional state remains scoped to the active query', async () => {
  const { conditionalUpgradeClient } = await import('./dispatch-launch-contract')
  const active = conditionalUpgradeClient(),
    predecessor = conditionalUpgradeClient()
  const guards = { handoff: null, rollbackRecorded: false, failedRoot: null }
  let attempts = 0
  for (let i = 0; i < 3; i++) {
    await expect(
      active('broken-new-run', async () => {
        attempts++
        throw new Error('unloadable')
      }),
    ).rejects.toThrow('unloadable')
    const answer = await predecessor('old-reader/new-run', async (request) =>
      request.position === undefined
        ? {
            conditionalVersion: 1,
            kind: 'full',
            identity: request.identity,
            position: '42',
            guards,
            projection: { version: 1, handoff: null, takeover: true, accepted: true },
          }
        : {
            conditionalVersion: 1,
            kind: 'unchanged',
            identity: request.identity,
            position: '42',
            handoff: null,
            rollbackRetained: false,
          },
    )
    expect(answer.takeover).toBe(true)
    expect(answer.accepted).toBe(true)
  }
  expect(attempts).toBe(3)
  await predecessor('old-reader/recovery-run', async (request) => {
    expect(request.position).toBeUndefined()
    return { version: 1, handoff: null, takeover: false }
  })
})
