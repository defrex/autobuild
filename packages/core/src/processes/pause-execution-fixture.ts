/** Real child-runner boundary for the immediate-pause process test. */
import { parseConfig } from '../config/load'
import { FakeForge } from '../ports/forge/fake'
import { ClaudeAgentRunner } from '../ports/runner/claude'
import { openLocalStore } from '../store/local/store'
import { BUILD_RUNNER_OPTIONS_ENV } from '../ports/workspace/local-build-execution'
import { BuildRunner } from './build-runner'

if (import.meta.main) {
  const input = JSON.parse(process.env[BUILD_RUNNER_OPTIONS_ENV]!)
  const store = openLocalStore(input.storeRef)
  process.env.AB_NATIVE_FIXTURE_STATE = input.workspaceRef
  const runner = new ClaudeAgentRunner()
  const build = new BuildRunner({
    store: store.scopeBuild(input.slug),
    config: parseConfig(
      '[tickets]\nsource = "file"\nreadyState = "ready"\n[roles.default]\nruntime = "claude"\n',
    ),
    runtimes: { claude: { runner, servesModels: ['claude-'] } },
    workspacePath: input.workspaceRef,
    workspaceProvider: 'git-worktree',
    workspaceRemote: input.slug.endsWith('-remote'),
    branch: 'ab/pause-process',
    slug: input.slug,
    instance: input.instance,
    host: 'fixture',
    forge: new FakeForge(),
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    ids: (prefix) => `${prefix}_${crypto.randomUUID()}`,
    clock: () => new Date(),
  })
  try {
    await build.run()
  } finally {
    await store.close()
  }
}
