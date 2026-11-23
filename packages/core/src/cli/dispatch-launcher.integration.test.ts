import { inheritedGitConfigIsolation } from '../testing/git-config-isolation'
import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp as makeTemporary, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distributionPath } from '../distribution'
import { openLocalStore } from '../store/local/store'
import { GENERATION_SIGNALS } from './dispatch-launch-contract'

const mkdtemp = ownTempDirectories(afterEach)

/** One checkout for the real launches below. The first launch prepares the
 * checkout's runtime cache and later launches reuse its dependency layer;
 * each test keeps its own store, so leases and run facts never mix. */
let shared: Promise<string> | undefined
const launchCheckout = () =>
  (shared ??= (async () => {
    const checkout = await makeTemporary(join(tmpdir(), 'ab-launch-shared-'))
    await mkdir(join(checkout, 'tickets/ready'), { recursive: true })
    await writeFile(
      join(checkout, 'autobuild.toml'),
      'forge = "local-git"\n[roles.default]\nruntime = "claude"\n[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
    )
    return checkout
  })())
afterAll(async () => {
  if (shared) await rm(await shared, { recursive: true, force: true })
})

for (const signal of GENERATION_SIGNALS)
  test(`production launcher drains ${signal} and records the original signal`, async () => {
    const checkout = await launchCheckout()
    const storePath = join(checkout, '.autobuild', `store-${signal}`)
    const store = openLocalStore(storePath)
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
          ...inheritedGitConfigIsolation(),
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
      // Each start prepares a full launch runtime (~14 s idle); verify runs
      // this under parallel load, so the start budget leaves wide headroom.
      const deadline = Date.now() + 90000
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
    }
  }, 120000)

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
  const cwd = await launchCheckout()
  const script = `
import os, pty, select, sys, time, shlex, signal, termios
pid, fd = pty.fork()
if pid == 0:
 os.chdir(sys.argv[1])
 os.environ['PS1'] = 'SHELL_READY> '
 os.environ['TERM'] = 'xterm-256color'
 os.execlp('bash', 'bash', '--noprofile', '--norc', '-i')
output = b''
def drain(wait=.05):
 global output
 if select.select([fd], [], [], wait)[0]: output += os.read(fd, 65536)
def until(marker, timeout=40):
 deadline = time.monotonic() + timeout
 while marker not in output:
  if time.monotonic() > deadline: raise Exception('missing '+repr(marker)+' in '+repr(output[-3000:]))
  drain()
def wait_for(label, predicate, timeout, detail=lambda: ''):
 deadline = time.monotonic() + timeout
 while True:
  value = predicate()
  if value: return value
  if time.monotonic() > deadline: raise Exception(label+' within '+str(timeout)+'s; '+detail()+'; output '+repr(output[-3000:]))
  drain(.02)
def children(parent):
 try:
  with open('/proc/'+str(parent)+'/task/'+str(parent)+'/children') as f: return [int(p) for p in f.read().split()]
 except OSError: return []
def stat(p):
 try:
  with open('/proc/'+str(p)+'/stat') as f: s = f.read()
 except OSError: return None
 return s[s.rindex(')')+2:].split()
def state(p):
 s = stat(p)
 return s[0] if s else None
def cmdline(p):
 try:
  with open('/proc/'+str(p)+'/cmdline', 'rb') as f: return f.read().replace(bytes(1), b' ')
 except OSError: return b''
def tree(p, depth=0):
 return ' '*depth+str(p)+'('+str(state(p))+') '+repr(cmdline(p)[-80:])+'; '+''.join(tree(c, depth+1) for c in children(p))
def wait_state(label, pids, stopped, timeout=20):
 def settled():
  for p in pids:
   if state(p) is None: raise Exception(label+': pid '+str(p)+' exited')
  return all((state(p) == 'T') == stopped for p in pids)
 wait_for(label, settled, timeout, lambda: 'states '+', '.join(str(p)+'='+str(state(p)) for p in pids))
def roles():
 def find():
  launchers = children(pid)
  if len(launchers) != 1 or b'bin/ab.ts' not in cmdline(launchers[0]): return None
  kernels = [k for c in children(launchers[0]) for k in children(c) if b'ab-dispatch-kernel.ts' in cmdline(k)]
  return len(kernels) == 1 and (launchers[0], kernels[0])
 launcher, kernel = wait_for('kernel spawned', find, 20, lambda: tree(pid))
 generation = int((stat(kernel) or ['', '0'])[1])
 assert generation in children(launcher) and b'ab-dispatch-generation.ts' in cmdline(generation), tree(pid)
 return launcher, generation, kernel
# Each launch prepares a full runtime; contended hosts need wide headroom.
LAUNCH = 90
RAW = termios.ICANON | termios.ECHO | termios.ISIG
def raw(): return termios.tcgetattr(fd)[3] & RAW == 0
try:
 until(b'SHELL_READY> ')
 def mode(raw_expected):
  global output
  if raw_expected:
   wait_for('raw mode restored', raw, 20, lambda: repr(termios.tcgetattr(fd)[3]))
  else:
   # Bash readline itself disables ICANON/ECHO at the prompt. Inspect the
   # shell's restored settings in a foreground command instead.
   output = b''
   probe = "import termios,time; mask=termios.ICANON|termios.ECHO|termios.ISIG; ok=any(termios.tcgetattr(0)[3] & mask == mask or time.sleep(.05) for _ in range(200)); print('COOKED'+'_OK' if ok else 'COOKED'+'_BAD '+repr(termios.tcgetattr(0)[3]))"
   os.write(fd, (shlex.join(['python3', '-c', probe])+'\\n').encode())
   wait_for('cooked probe', lambda: b'COOKED_OK' in output or b'COOKED_BAD' in output, 40)
   assert b'COOKED_OK' in output, repr(output)
   until(b'SHELL_READY> ')
 output = b''
 command = shlex.join(sys.argv[2:])
 os.write(fd, (command+'\\n').encode())
 until(b'\\x1b[?1049h', LAUNCH)
 launcher, generation, kernel = roles()
 # With ISIG still on, ^Z would stop the whole foreground group, kernel included.
 wait_for('dashboard raw mode', raw, 20, lambda: repr(termios.tcgetattr(fd)[3]))
 wait_state('generation running', [generation], False)
 output = b''
 os.write(fd, b'\\x1a')
 wait_state('presentation job stopped after Ctrl-Z (launcher must stop on SIGTSTP)', [generation, launcher], True)
 until(b'SHELL_READY> ', 20)
 assert b'Stopped' in output, output
 # The job is confirmed stopped, so this window samples a settled kernel.
 for _ in range(5):
  assert state(kernel) is not None, 'kernel exited while suspended'
  assert state(kernel) != 'T', 'kernel stopped with the presentation job'
  time.sleep(.05)
 mode(False)
 output = b''
 os.write(fd, b'fg\\n')
 wait_state('presentation job resumed after fg', [launcher, generation], False)
 until(b'\\x1b[?1049h', 20)
 mode(True)
 output = b''
 os.write(fd, b'\\x03')
 until(b'SHELL_READY> ')
 assert output.count(b'\\x1b[?1049l') == 1, repr(output)
 mode(False)
 # --plain on a TTY never owned an alternate screen. Bash itself toggles
 # bracketed paste around each command line, so only launcher-only modes count.
 output = b''
 os.write(fd, (command+' --plain\\n').encode())
 until(b'Ctrl-C to stop', LAUNCH)
 os.write(fd, b'\\x03')
 until(b'SHELL_READY> ')
 for unowned in (b'\\x1b[?1049l', b'\\x1b[?1004l', b'\\x1b[<1u'):
  assert unowned not in output, repr(output)
 # A genuine --plain failure still restores no mode the launcher never enabled.
 output = b''
 os.write(fd, (command+' --plain\\n').encode())
 until(b'Ctrl-C to stop')
 os.kill(children(children(pid)[0])[0], signal.SIGKILL)
 until(b'SHELL_READY> ')
 for unowned in (b'\\x1b[?1049l', b'\\x1b[?1004l', b'\\x1b[<1u'):
  assert unowned not in output, repr(output)
 output = b''
 os.write(fd, (command+'\\n').encode())
 until(b'\\x1b[?1049h', LAUNCH)
 generation = roles()[1]
 output = b''
 os.kill(generation, signal.SIGKILL)
 until(b'SHELL_READY> ')
 assert output.count(b'\\x1b[?1049l') == 1, repr(output)
 print('shell regained control; fg resumed; clean exits preserved terminal frame; crash restored modes')
finally:
 os.write(fd, b'exit\\n')
 os.close(fd)
 os.kill(pid, signal.SIGHUP)
 os.waitpid(pid, 0)
`
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
      '--store',
      join(cwd, '.autobuild', 'store-job-control'),
    ],
    {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...inheritedGitConfigIsolation() },
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
}, 300000)

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

test('public viewer bypasses the immutable launcher and execution config in non-TTY mode', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-viewer-routing-'))
  const child = Bun.spawn(
    [
      process.execPath,
      distributionPath('bin/ab.ts'),
      'dispatch',
      '--viewer',
      '--dispatched-by',
      'app.autobuild.run',
    ],
    {
      cwd,
      env: { PATH: process.env.PATH },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdoutDone = (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ''
    let stopped = false
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += decoder.decode(chunk.value, { stream: true })
      if (!stopped && output.includes('No dispatcher has run for this project yet.')) {
        stopped = true
        await Bun.sleep(30)
        expect(child.exitCode).toBeNull()
        child.kill('SIGINT')
      }
    }
    return output
  })()
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    stdoutDone,
    new Response(child.stderr).text(),
  ])
  expect(code).toBe(0)
  expect(stderr).toBe('')
  expect(stdout).toContain('viewer · dispatched by app.autobuild.run')
  expect(stdout).toContain('No dispatcher has run for this project yet.')
  await expect(access(join(cwd, '.autobuild/runtime'))).rejects.toThrow()
})

for (const fail of [false, true])
  test(`public hosted placement selects viewer before launcher (failure=${fail})`, async () => {
    const { MemoryBuildStore } = await import('../store/memory')
    const cwd = await mkdtemp(join(tmpdir(), 'ab-hosted-public-'))
    const store = new MemoryBuildStore()
    await store.ensureRepo(cwd)
    let reads = 0
    const service = {
      store,
      placement: async () => {
        reads++
        if (fail) throw new Error('placement unavailable')
        return {
          status: 'known',
          placement: { hosted: true, origin: 'https://app.autobuild.run:8443' },
        }
      },
    }
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        if (path === '/health') return Response.json({ capabilities: ['dispatch-placement-v1'] })
        if (path.endsWith('/placement')) {
          try {
            return Response.json(await service.placement())
          } catch {
            return new Response('placement unavailable', { status: 503 })
          }
        }
        if (path.endsWith('/change-position')) return Response.json({ position: '0' })
        if (path.endsWith('/reducer-values')) {
          const { version, cursor, value } = await store.getReducerValue(
            { kind: 'repo', repo: cwd },
            await request.json(),
          )
          return Response.json({ version, cursor, value })
        }
        if (/^\/repos\/[^/]+$/.test(path)) return Response.json(await store.getRepo(cwd))
        throw new Error(`Unexpected viewer request: ${request.method} ${path}`)
      },
    })
    const child = Bun.spawn(
      [process.execPath, distributionPath('bin/ab.ts'), 'dispatch', '--plain'],
      {
        cwd,
        env: { PATH: process.env.PATH, AB_STORE: server.url.origin },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    try {
      const output = (async () => {
        const reader = child.stdout.getReader()
        let result = ''
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) return result
          result += new TextDecoder().decode(chunk.value)
          if (result.includes('No dispatcher has run for this project yet.')) child.kill('SIGINT')
        }
      })()
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        output,
        new Response(child.stderr).text(),
      ])
      expect(reads).toBe(1)
      if (fail) {
        expect(code).toBe(1)
        expect(stderr).toContain('--viewer')
        expect(stderr).toContain('--takeover')
      } else {
        expect(code).toBe(0)
        expect(stdout).toContain('viewer · dispatched by app.autobuild.run:8443')
        expect(stderr).toBe('')
      }
      await expect(access(join(cwd, '.autobuild/runtime'))).rejects.toThrow()
    } finally {
      if (child.exitCode === null) child.kill('SIGINT')
      await server.stop(true)
    }
  })
