import { expect, test } from 'bun:test'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRuntime } from '../cli/dispatch-runtime-cache'
import { releasePreparedRuntime } from '../cli/dispatch-runtime-use'
import { distributionRoot } from '../distribution'
import { spawnExec } from '../ports/workspace/git-worktree'
import { openLocalStore } from '../store/local/store'
import type { RepositoryEvent } from '../events/repository'

test('real launcher sequentially adopts two replacements of the original installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-hot-upgrade-'))
  const repo = join(root, 'repo'),
    original = join(root, 'installation')
  await mkdir(repo)
  await mkdir(join(repo, 'tickets/ready'), { recursive: true })
  const seed = await prepareRuntime(distributionRoot(), repo)
  await cp(seed.root, original, { recursive: true, verbatimSymlinks: true })
  releasePreparedRuntime(seed.root)
  const manifest = JSON.parse(await readFile(join(original, 'package.json'), 'utf8'))
  const replace = async (version: string) =>
    writeFile(join(original, 'package.json'), JSON.stringify({ ...manifest, version }))
  await replace('1.0.0')
  const targetFile = join(original, 'packages/core/src/cli/dispatch-upgrade-target.ts')
  await writeFile(targetFile, (await readFile(targetFile, 'utf8')).replace('60_000', '100'))
  await writeFile(join(repo, 'package.json'), '{}')
  await writeFile(
    join(repo, 'autobuild.toml'),
    'forge = "local-git"\n[roles.default]\nruntime = "claude"\n[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
  )
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.com'],
    ['add', 'package.json', 'autobuild.toml'],
    ['commit', '-m', 'fixture'],
  ]) {
    const result = await spawnExec(['git', ...args], { cwd: repo })
    if (result.exitCode) throw new Error(result.stderr)
  }
  const storePath = join(repo, '.autobuild/store')
  const store = openLocalStore(storePath)
  await store.ensureRepo(repo)
  const child = Bun.spawn(
    [
      process.execPath,
      join(original, 'bin/ab.ts'),
      'dispatch',
      '--plain',
      '--interval',
      '0.05',
      '--store',
      storePath,
    ],
    {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text()
  const wait = async (predicate: (events: RepositoryEvent[]) => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 120_000
    for (;;) {
      const events = await store.getRepoEvents(repo)
      if (await predicate(events)) return events
      if (child.exitCode !== null) throw new Error(`launcher exited: ${await stderr}`)
      if (Date.now() > deadline)
        throw new Error(
          `handoff timeout: ${JSON.stringify(events.filter((e) => e.type.includes('upgrade') || e.type.includes('handoff')))}`,
        )
      await Bun.sleep(50)
    }
  }
  try {
    await wait((events) => events.some((e) => e.type === 'dispatcher.runtime-recorded'))
    for (const version of ['2.0.0', '3.0.0']) {
      await replace(version)
      const events = await wait((events) =>
        events.some(
          (e) =>
            e.type === 'dispatcher.handoff-completed' &&
            e.payload.to.version === version &&
            events.some(
              (start) =>
                start.type === 'dispatcher.run-started' &&
                start.payload.run === e.payload.successor,
            ),
        ),
      )
      const completion = events.findLast((e) => e.type === 'dispatcher.handoff-completed')!
      if (completion.type !== 'dispatcher.handoff-completed') throw new Error('missing completion')
      expect(completion.payload.target).toMatchObject({
        mode: 'installed',
        source: original,
        version,
      })
      const stop = events.find(
        (e) => e.type === 'dispatcher.run-stopped' && e.payload.run === completion.payload.run,
      )!
      const start = events.find(
        (e) =>
          e.type === 'dispatcher.run-started' && e.payload.run === completion.payload.successor,
      )!
      const accepted = events.find(
        (e) => e.type === 'dispatcher.handoff-started' && e.payload.run === completion.payload.run,
      )!
      const released = events.find(
        (e) =>
          e.type === 'dispatcher.terminal-released' && e.payload.run === completion.payload.run,
      )!
      const takeover = events.find(
        (e) => e.type === 'dispatcher.takeover' && e.payload.run === completion.payload.run,
      )!
      expect(released.seq).toBeLessThan(takeover.seq)
      expect(takeover.seq).toBeLessThan(start.seq)
      if (accepted.type === 'dispatcher.handoff-started' && accepted.payload.mode === 'cutover')
        expect(stop.seq).toBeLessThan(start.seq)
      expect(
        events.filter(
          (e) =>
            e.type === 'dispatcher.tick-started' &&
            e.payload.run === completion.payload.run &&
            e.seq > accepted.seq,
        ),
      ).toHaveLength(0)
      expect((await store.getRepo(repo))!.lease?.holder).toBe(completion.payload.successor)
    }
    const beforeFailure = (await store.getRepo(repo))!.lease!.holder
    const validConfig = await readFile(join(repo, 'autobuild.toml'), 'utf8')
    await writeFile(join(repo, 'autobuild.toml'), 'store = [invalid TOML')
    await replace('4.0.0')
    const failed = await wait((events) =>
      events.some(
        (event) =>
          event.type === 'dispatcher.upgrade-failed' && event.payload.target.version === '4.0.0',
      ),
    )
    const failure = failed.findLast((event) => event.type === 'dispatcher.upgrade-failed')!
    expect(
      failed.some(
        (event) =>
          event.type === 'dispatcher.handoff-started' && event.payload.to.version === '4.0.0',
      ),
    ).toBe(false)
    expect((await store.getRepo(repo))!.lease!.holder).toBe(beforeFailure)
    await wait(async () => {
      const finished = (await store.getRepo(repo))!.tick?.finished
      return (
        finished?.run === beforeFailure && Date.parse(finished.completedAt) > Date.parse(failure.ts)
      )
    })
    await writeFile(join(repo, 'autobuild.toml'), validConfig)
    child.kill('SIGINT')
    await child.exited
    expect(child.exitCode).toBe(0)
    expect(await stderr).toContain('config reload rejected')
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGINT')
      await child.exited
    }
    await stdout
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
}, 300_000)

for (const crashed of process.platform === 'linux' ? [false, true, 'successor'] : [false])
  test(`PTY successor keeps descriptors and input after ${crashed === true ? 'predecessor death' : crashed === 'successor' ? 'successor preflight death' : 'terminal release'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-handoff-pty-'))
    const repo = join(root, 'repo'),
      original = join(root, 'installation')
    await mkdir(repo)
    await mkdir(join(repo, 'tickets/ready'), { recursive: true })
    const seed = await prepareRuntime(distributionRoot(), repo)
    await cp(seed.root, original, { recursive: true, verbatimSymlinks: true })
    releasePreparedRuntime(seed.root)
    const manifest = JSON.parse(await readFile(join(original, 'package.json'), 'utf8'))
    await writeFile(
      join(original, 'package.json'),
      JSON.stringify({ ...manifest, version: '1.0.0' }),
    )
    const releaseGate = join(root, 'release-presentation')
    if (crashed) {
      const frontend = join(original, 'packages/core/src/cli/dispatch-frontend.ts')
      await writeFile(
        frontend,
        (await readFile(frontend, 'utf8')).replace(
          'await this.finishPresentation()',
          `if (!launchContext(this.opts.env)?.predecessor) while (!await Bun.file(${JSON.stringify(releaseGate)}).exists()) await new Promise<void>(resolve => setTimeout(resolve, 25));\n        await this.finishPresentation()`,
        ),
      )
    }

    const targetFile = join(original, 'packages/core/src/cli/dispatch-upgrade-target.ts')
    await writeFile(targetFile, (await readFile(targetFile, 'utf8')).replace('60_000', '100'))
    await writeFile(join(repo, 'package.json'), '{}')
    await writeFile(
      join(repo, 'autobuild.toml'),
      'forge="local-git"\n[roles.default]\nruntime="claude"\n[tickets]\nsource="file"\ndir="tickets"\nreadyState="ready"\n',
    )
    for (const args of [
      ['init', '-b', 'main'],
      ['config', 'user.name', 'Test'],
      ['config', 'user.email', 'test@example.com'],
      ['add', '.'],
      ['commit', '-m', 'fixture'],
    ]) {
      const result = await spawnExec(['git', ...args], { cwd: repo })
      if (result.exitCode) throw new Error(result.stderr)
    }
    const storePath = join(repo, '.autobuild/store')
    const store = openLocalStore(storePath)
    await store.ensureRepo(repo)
    const terminalLog = join(root, 'terminal.log')
    const script = `
import os, pty, select, sys, json
pid, fd = pty.fork()
if pid == 0:
 os.chdir(sys.argv[1]); os.environ['TERM']='xterm-256color'
 os.execv(sys.argv[2], [sys.argv[2], sys.argv[3], 'dispatch', '--interval', '0.05', '--store', sys.argv[4]])
buffer=b''
with open(sys.argv[5], 'wb') as output:
 while True:
  ready,_,_=select.select([fd,sys.stdin.buffer],[],[],.1)
  if sys.stdin.buffer in ready:
   data=os.read(sys.stdin.fileno(),65536)
   if not data: break
   buffer+=data
   while b'\\n' in buffer:
    line,buffer=buffer.split(b'\\n',1); os.write(fd,json.loads(line).encode())
  if fd in ready:
   try: data=os.read(fd,65536)
   except OSError: break
   if not data: break
   output.write(data); output.flush()
_,status=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(status))
`
    const child = Bun.spawn(
      [
        'python3',
        '-c',
        script,
        repo,
        process.execPath,
        join(original, 'bin/ab.ts'),
        storePath,
        terminalLog,
      ],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    )
    const stderr = new Response(child.stderr).text(),
      stdout = new Response(child.stdout).text()
    const wait = async (predicate: (events: RepositoryEvent[]) => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 90_000
      for (;;) {
        const events = await store.getRepoEvents(repo)
        if (await predicate(events)) return events
        if (child.exitCode !== null) throw new Error(`PTY launcher exited: ${await stderr}`)
        if (Date.now() > deadline)
          throw new Error(
            `PTY handoff timeout: ${JSON.stringify(events.filter((e) => /upgrade|handoff|yield|takeover|released/.test(e.type)))}`,
          )
        await Bun.sleep(25)
      }
    }
    try {
      await wait((events) => events.some((e) => e.type === 'dispatcher.tick-completed'))
      await writeFile(
        join(original, 'package.json'),
        JSON.stringify({ ...manifest, version: '2.0.0' }),
      )
      if (crashed) {
        const accepted = await wait((events) =>
          events.some((event) => event.type === 'dispatcher.handoff-started'),
        )
        const predecessor = accepted.find((event) => event.type === 'dispatcher.handoff-started')!
          .payload.run
        const started = accepted.find(
          (event) => event.type === 'dispatcher.run-started' && event.payload.run === predecessor,
        )!
        if (started.type !== 'dispatcher.run-started') throw new Error('missing predecessor kernel')
        const stat = await readFile(`/proc/${started.payload.pid}/stat`, 'utf8')
        const presentationPid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
        if (crashed === true) process.kill(presentationPid, 'SIGKILL')
        else {
          const presentationStat = await readFile(`/proc/${presentationPid}/stat`, 'utf8')
          const launcherPid = Number(
            presentationStat.slice(presentationStat.lastIndexOf(')') + 2).split(' ')[1],
          )
          const children = (
            await readFile(`/proc/${launcherPid}/task/${launcherPid}/children`, 'utf8')
          )
            .trim()
            .split(/\s+/)
          let successorPid: number | undefined
          for (const child of children) {
            try {
              if (
                (await readFile(`/proc/${child}/cmdline`, 'utf8'))
                  .split('\0')
                  .includes('--preflight')
              )
                successorPid = Number(child)
            } catch {}
          }
          if (!successorPid) throw new Error('missing gated preflight process')
          process.kill(successorPid, 'SIGKILL')
          await writeFile(releaseGate, 'release')
        }
      }
      const events = await wait(
        (events) =>
          events.some((e) => e.type === 'dispatcher.takeover') &&
          events
            .filter((e) => e.type === 'dispatcher.tick-completed')
            .some(
              (e) =>
                e.payload.run ===
                events.find((e) => e.type === 'dispatcher.takeover')!.payload.successor,
            ),
      )
      const released = events.find((e) => e.type === 'dispatcher.terminal-released')!
      const takeover = events.find((e) => e.type === 'dispatcher.takeover')!
      expect(released.seq).toBeLessThan(takeover.seq)
      const before = (await readFile(terminalLog)).length
      child.stdin.write(`${JSON.stringify('i')}\n`)
      await wait((events) =>
        events.some((e) => e.type === 'dispatcher.intake-set' && e.seq > takeover.seq),
      )
      await wait(async () => (await readFile(terminalLog)).length > before)
      expect((await readFile(terminalLog)).length).toBeGreaterThan(before)
      child.stdin.write(`${JSON.stringify('\x03')}\n`)
      expect(await child.exited).toBe(0)
      expect(await stderr).toBe('')
      expect(await readFile(terminalLog, 'utf8')).toContain('\x1b[?25h')
    } finally {
      await writeFile(releaseGate, 'release').catch(() => {})
      if (child.exitCode === null) {
        child.stdin.write(`${JSON.stringify('\x03')}\n`)
        await child.exited
      }
      await stdout
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)
