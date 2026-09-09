# Repository setup

Configure Autobuild outside the build pipeline. This conversation is not a
build or phase. Work directly in the repository and involve the maintainer in
choices that cannot be derived from source. Secrets belong in the environment
or an ignored `.env`, never in `autobuild.toml`, commits, or validation reports.

## Choose the execution environment

Keep the default `git-worktree` provider unless the maintainer explicitly opts
into remote builds. It creates local disposable worktrees and uses the tools,
network, and credentials available to the dispatcher machine.

For remote execution, set `[workspace].provider = "vercel-sandbox"`. A Vercel
Sandbox is a fresh independent machine; a runtime that works on the setup
machine is not evidence that it works there. Confirm all of these with the
maintainer before selecting it:

- the intended Vercel team and project;
- durable dispatcher authentication with `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and
  `VERCEL_PROJECT_ID`, or short-lived `VERCEL_OIDC_TOKEN` obtained from a linked
  project (`vercel link` and `vercel env pull`); when validating a target other
  than the current directory, export OIDC in the launcher environment because
  the Vercel SDK resolves it from ambient process state. Access-token
  credentials in the target's ignored `.env` are the durable choice for a
  continuously running local dispatcher;
- an HTTPS `github.com/owner/repository` origin and `forge = "github"`;
- a dispatcher-side push-capable `GITHUB_TOKEN` or `GH_TOKEN`;
- for a private repository, a separate read-only clone identity named by
  `gitUsernameEnv` and `gitPasswordEnv`;
- an HTTPS hosted `AB_STORE` reachable from Vercel and a scoped `AB_TOKEN`;
- each selected role and alternate's runtime/model, and the credential variable
  names that runtime needs in `[workspace.config].environmentVariables`.

Do not put `AB_STORE`, `AB_TOKEN`, Vercel credentials, Forge credentials, or
private-clone credentials in `environmentVariables`. Autobuild supplies Store
credentials separately, keeps clone credentials out of guest commands, and
performs publication from the trusted host.

```toml
[workspace]
provider = "vercel-sandbox"

[workspace.config]
image = "vercel/sandbox/universal:latest"
vcpus = 4
timeoutSeconds = 2700
environmentVariables = ["ANTHROPIC_API_KEY"]
# Private repositories only:
# gitUsernameEnv = "AB_GIT_READ_USER"
# gitPasswordEnv = "AB_GIT_READ_TOKEN"
```

## Make the environment reproducible

Inspect the repository's manifests, documentation, CI, test layout, and
conventions. Read the installed sibling `../SKILL.md` for Autobuild's complete
configuration and ticket surfaces.

Use the supported `vercel/sandbox/universal` image. Other managed images and
custom VCR images are rejected. Autobuild remains stack-neutral: put the
repository's own reproducible toolchain bootstrap in idempotent
`[commands].setup`, and expose only required runtime credentials through
`[workspace.config].environmentVariables`. For example, setup may install
Python and `uv`, a pinned Rust toolchain and native libraries, or a JDK and
Gradle. Those are repository decisions, not toolchains inferred by Autobuild.

Configure an idempotent `[commands].setup` to install package dependencies and
perform repeatable bootstrap on every fresh or replacement environment. It must
be safe to rerun. Keep generated caches disposable and lock dependencies in the
repository. Then:

1. Configure real `[commands]` and ordered `[verify]` steps from the toolchain
   this repository actually uses. Do not invent commands or retain placeholders.
2. Decide the runtime and model arrangement for every pipeline role and
   alternate. The runtime that launched setup and the temporary fresh-skeleton
   default do not constrain the final arrangement.
3. Choose the ticket source and workflow states. Confirm account/team facts and
   required environment credentials. Configure end-to-end verification with the
   repository's real lifecycle and tools. When judgment is required, author a repository-owned
   agent-verify skill and select it from an agent verify step.
4. Preserve an existing `autobuild.toml` and unrelated repository choices on a
   rerun. Change only choices the maintainer approves.
5. Commit the config, setup files, lockfiles, and installed reference changes,
   then push them to `baseBranch`. A remote sandbox clones the authoritative
   GitHub revision; it cannot acquire local-only edits.
6. Run `ab init --validate`. Fix every named failure and rerun until every check
   passes. Only then use the installed grooming/ticket skills to create the
   first groomed Ready ticket and start `ab dispatch`.

Validation is explicit and noninteractive. It does not dispatch, claim a
ticket, or create build, phase, session, event, transcript, or artifact history.
For local execution it identifies and removes a disposable detached worktree.
For Vercel it identifies and permanently deletes a fresh unnamed sandbox, even
when setup or a probe fails; cleanup failures name the environment for manual
deletion. It runs `commands.setup`, loads repository plugins, checks every
selected primary/alternate runtime and model, and performs a read-only Store
request in the candidate execution context. If the local database is absent,
validation reports that no repository history is available without creating
`.autobuild` or any SQLite files. If it exists, validation copies the database
and any WAL/SHM sidecars to a disposable filesystem snapshot and inspects that
copy without SQLite-opening or modifying the repository Store files. It never
silently falls back from Vercel to local execution. Local launcher probes
printed by ordinary `ab init` are only setup-agent discovery and are not remote
readiness evidence.

Typical remediation is intentionally specific: add a missing executable to the
setup command while retaining the universal image; add a runtime credential name to
`environmentVariables` and its value to the dispatcher environment; correct the
Vercel team/project credential set; provide separate private-clone credentials;
use an HTTPS GitHub origin and hosted Store; authorize the Store token; or commit
and push the selected base branch.

## Authoring an agent verifier

A repository-owned agent-verify skill is a verifier, not a reviewer: it drives
the running application and observes whether the spec's acceptance criteria
hold. It does not inspect the diff for style or edit product code.

Its session instructions must preserve this contract:

1. Run `ab context`. The verifier receives `.ab/spec.md`, the configured step,
   the commit range, and, after escalation is answered, `.ab/guidance.json`.
2. Exercise each applicable acceptance criterion through the repository's real
   application lifecycle. Prefer the narrowest honest flow that catches a
   regression.
3. Write criterion-oriented evidence: criterion, action, observation, and
   pass/fail. Failures include reproduction inputs, expected/observed behavior,
   and relevant repository-native logs.
4. Deposit passing review evidence explicitly with
   `ab artifact put <kind> <file> --attach`. Never attach failed or partial
   output; use stable kinds so retries replace the designation.
5. Finish with exactly one terminal:

   ```text
   ab verdict pass --notes <report-file>
   ab verdict fail --report <report-file>
   ab verdict skip --reason "Why this entire step does not apply"
   ```

An applicable behavior that cannot be exercised is a failure with an
explanation, never a skip or silent pass. Use `skip` only when the complete step
does not apply. If guidance still cannot make a verdict possible, escalate and
explain what remains unresolved. Record out-of-scope work with `ab observe`;
the verifier does not fix it.
