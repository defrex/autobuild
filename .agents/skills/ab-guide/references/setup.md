# Repository setup

Install Autobuild in the target repository with `bun add -d --exact @defrex/autobuild`.
Here, `ab <command>` means the repository-installed CLI; run it as
`bun ab <command>`, for example `bun ab init`.

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
- a remote store that speaks the remote BuildStore protocol and is reachable from Vercel, configured through `ab connect <url>`;
- each selected role and alternate's runtime/model, its pinned
  `[workspace.config.runtimeProvisioning.<runtime>]` commands, and the API
  credential names it needs in `[workspace.config].environmentVariables`.

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
environmentVariables = ["AI_GATEWAY_API_KEY"]
# Ordered system-level steps run once in every fresh/replacement sandbox as root.
provisioning = [
  { name = "system-install", command = """apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y chromium""" },
  { name = "browser-smoke", command = "CHROMIUM_BIN=/usr/bin/chromium ./scripts/browser-smoke.sh" },
]
# Private repositories only:
# gitUsernameEnv = "AB_GIT_READ_USER"
# gitPasswordEnv = "AB_GIT_READ_TOKEN"

[workspace.config.runtimeProvisioning.pi]
install = "npm install --global --ignore-scripts @earendil-works/pi-coding-agent@0.84.4"
preflight = "test \"$(pi --version)\" = \"0.84.4\" && pi update --models"
```

Use a `vercel-ai-gateway/...` Pi model with `AI_GATEWAY_API_KEY` in the
dispatcher environment. For Claude Code, configure [accounts](accounts.md) with a manually provisioned `claude setup-token` credential or a Kimi Code membership key; use the unmodified runtime, your own subscription, and ordinary individual usage. Pi and Codex local auth state and OAuth refresh tokens are not copied, and interactive sandbox login is unsupported. Runtime
names are open: a plugin runtime uses the same strict map, for example
`[workspace.config.runtimeProvisioning.opencode]`, with its own immutable
install and exact-version preflight commands.

## Make the environment reproducible

Inspect the repository's manifests, documentation, CI, test layout, and
conventions. Read the installed sibling `../SKILL.md` for Autobuild's complete
configuration and ticket surfaces.

Use the supported `vercel/sandbox/universal` image. Other managed images and
custom VCR images are rejected. Autobuild remains stack-neutral. For Vercel,
put repository-specific operating-system packages and machine-level tooling in
the ordered `[workspace.config].provisioning` list. Each strict `{ name,
command }` entry runs from the checkout through `sh -c` with provider root
authority after pinned Bun is verified and before dependency bootstrap,
`[commands].setup`, or an agent. It runs once per fresh environment and repeats
on every replacement. Commands are declarative TOML string data, not evaluated
configuration logic. Local git worktrees never run this list; ensure their host
already has required system tooling.

Put each selected runtime's immutable install and executable/version check in
its `runtimeProvisioning` entry. Autobuild runs install then preflight after
checkout dependencies in every fresh/replacement sandbox and before the
readiness probe, writes the marker only after success, and reruns every
preflight before each build runner. A failure names the runtime, selecting
role/alternate, and field and starts no agent. Runtime provisioning receives
only the API credentials named by `[workspace.config].environmentVariables`.

Keep package-level and checkout-level bootstrap in an idempotent
`[commands].setup`. It runs after system provisioning and must remain safe to
rerun on attachment. Do not repeatedly install OS packages there. Expose only
required runtime credentials through
`[workspace.config].environmentVariables`, keep generated caches disposable,
and lock dependencies in the repository. A browser-capable repository should
check in a dependency-free `scripts/browser-smoke.sh` that starts its dev server,
uses a repository-controlled path such as `CHROMIUM_BIN=/usr/bin/chromium` to
launch headless Chromium in the same guest, verifies the rendered page, and
exits nonzero on failure. Then:

1. Configure real `[commands]` and ordered `[verify]` steps from the toolchain
   this repository actually uses. Do not invent commands or retain placeholders.
2. Decide the runtime and model arrangement for every pipeline role and
   alternate. The runtime that launched setup and the temporary fresh-skeleton
   default do not constrain the final arrangement.
3. Choose the ticket source and workflow states. Confirm account/team facts and
   required environment credentials. Author a repository-owned acceptance-check skill and select it from an agent
   verify step in every repository. An **acceptance check** is a repository-owned agent verify step that runs the built software, exercises each acceptance criterion in the spec, attaches evidence, and returns a typed verdict. Every repository must configure one. It is not a test suite and leaves no test files behind.
   Wire an existing maintained end-to-end or browser test suite into an ordinary `check` step. If none exists, do not create one during setup. The acceptance check neither substitutes for nor seeds a suite.
4. Preserve an existing `autobuild.toml` and unrelated repository choices on a
   rerun. Change only choices the maintainer approves.
5. Commit the config, setup files, lockfiles, and installed reference changes,
   then push them to `baseBranch`. A remote sandbox clones the authoritative
   GitHub revision; it cannot acquire local-only edits.
6. Run `ab init --validate`. Fix every named failure, review warnings and unknowns, and rerun
   validation. Setup ends at successful validation. Ask the human to start
   `bun ab dispatch`, then open their coding agent at the repository root with
   `ab-operate` loaded to specify, create and groom the first ticket. Check operator
   presence before taking the role; an existing operator picks up ready work.
   The setup agent must not start dispatch itself.

Validation is explicit and noninteractive. It does not dispatch, claim a
ticket, or create build, phase, session, event, transcript, or artifact history.
For local execution it identifies and removes a disposable detached worktree.
For Vercel it identifies and permanently deletes a fresh unnamed sandbox, even
when system or runtime provisioning, setup, or a probe fails; cleanup failures
name the environment for manual deletion. Its `system provisioning` check lists
completed step names (or says none were declared) before guest setup checks. A
failed step reports its name, command, status, labeled stdout/stderr, and
remediation without marking the environment ready. It provisions/preflights
every effective primary and alternate runtime, then runs `commands.setup`, loads
repository plugins, and checks every
selected primary/alternate runtime and model, and performs a read-only Store
request in the candidate execution context. If the local database is absent,
validation reports that no repository history is available without creating
`.autobuild` or any SQLite files. If it exists, validation copies the database
and any WAL/SHM sidecars to a disposable filesystem snapshot and inspects that
copy without SQLite-opening or modifying the repository Store files. It never
silently falls back from Vercel to local execution. Local launcher probes
printed by ordinary `ab init` are only setup-agent discovery and are not remote
readiness evidence.

Typical remediation is intentionally specific: add a missing system executable
to `workspace.config.provisioning` (or a package dependency to setup) while
retaining the universal image; add a runtime credential name to
`environmentVariables` and its value to the dispatcher environment; correct the
Vercel team/project credential set; provide separate private-clone credentials;
use an HTTPS GitHub origin and remote Store; authorize the Store token; or commit
and push the selected base branch.

## Keep per-build records in separate fragments

When a repository keeps per-build records, such as changelog entries, write a
separate fragment file for each build and assemble the consolidated record at
release. For example, use distinct filenames per build (these names are
illustrative):

```text
changelog.d/
  build-alpha.md
  build-beta.md
CHANGELOG.md          # assembled from the fragments at release
```

Shared append-only files are an anti-pattern for finalize steps. Under the
integration tree, independent builds that append to the same shared lines can
conflict when their commits are replayed onto a destination that already has
other entries, including during restacks and node cascades. Each conflicting
replay costs an agent reconcile session. Separate fragment files remove that
shared edit surface; the repository owns the release-time assembly tooling.

## Repository identity is the origin, not a checkout path

Repository identity in the Store, dispatcher, `ab builds`, `ab build status`,
`ab repository status` is the repository's **normalized origin
URL** (`https://github.com/owner/repository`), not a checkout's absolute path.
Two checkouts of the same repository — on different hosts, or a dispatcher and
its sandboxes — agree on one identity.

Records written before this change are keyed by checkout path and are **not
migrated**. They remain visible only where their recorded `repoOrigin` matches
the querying checkout's origin; dropping the old identity's history is an
accepted trade for path-free operation.

## Running the dispatcher without a checkout (origin mode)

A dispatcher can operate a repository with no local checkout at all — from a
serverless function or any host with only network access:

```sh
ab dispatch --repository https://github.com/owner/repository \\
  --plain --store https://hosted-store.example \\
  # environment: AB_TOKEN (store), GITHUB_TOKEN or GH_TOKEN (GitHub API)
```

`--repository` (or `AB_REPOSITORY`) is the normalized origin. Origin mode
requires an HTTPS service selected through `[store] url` or `AB_STORE`, a saved project credential or `AB_TOKEN`, an exported `GITHUB_TOKEN` or
`GH_TOKEN`, and `forge = "github"`; the interactive dashboard is unavailable
(`--plain` or no TTY). Origin mode never consults the gh CLI: a checkout-less
host has no gh and no keyring, and the only workspace provider it can run,
`vercel-sandbox`, injects that same exported token for publication. The gh CLI
fallback (`GITHUB_TOKEN`, then `GH_TOKEN`, then the login stored by `gh auth
login`) is a checkout-mode convenience for a local dispatcher whose workspace
provider is not `vercel-sandbox`; that provider requires the exported token in
every mode. The
startup configuration — and every per-tick reload — is `autobuild.toml` read
from the forge at the current `baseBranch` (the first read resolves against the
repository's default branch), so a push to the base branch is honored by a
later tick without restarting anything. Configs declaring local `plugins` are
rejected: plugin code is checkout-relative. The guest installs the Autobuild
distribution published for its version — the npm registry tarball, else the
GitHub release asset `autobuild-<version>.tgz` — so origin-mode dispatch
requires a published release.

### Guest distribution version selection and delivery

Cached generations retain explicit archive provenance. A registry generation
resolves its manifest version’s GitHub release asset on first guest use, validates
version and digest, and atomically caches it separately from the host archive.
Local launch requires no GitHub fetch. Isolated and hoisted Bun installations
retain registry provenance through store-path or lock evidence. Source, Git and local package
generations deliver their exact packed code. Missing or invalid release assets
fail guest delivery and remain retryable, without falling back to packing the
registry installation.
Remote guests finish their phase before requesting relaunch; re-attachment
refreshes the archive and marker before the next runner starts. They retain
independent leases and never hold local retirement open.

The guest's distribution version is selected by the archive source, and both
sources agree with the running system by construction:

- **Source checkout** (dispatcher running from a repository checkout): the
  guest archive is packed from the host tree with `bun pm pack`, so the guest
  runs the dispatcher's own code.
- **Origin mode** (checkout-less dispatcher): the guest archive is the release
  asset `autobuild-<version>.tgz` fetched from the canonical repository at the
  **running dispatcher's version** (read from the installed distribution's
  `package.json`), so the guest runs the dispatcher's own release.

A service accepts stable and prerelease clients from its own `major.minor`
release line and the two preceding minor lines in the same major. A major starts a new family:
X.0 accepts only X.0, X.1 accepts X.0/X.1, and X.2 onward accepts three lines.
Patch versions are interchangeable in both directions and must never change
the protocol. Keep project clients within the instance’s published window. Supported release lines retain their wire handlers and known
protocol identities; an unknown protocol is refused independently of version.
Stable and prerelease service and client identities share their numeric major/minor
line. Malformed or missing identities, build metadata (`+…`), prefixes and
whitespace are refused with HTTP 409.
A newer client is told to upgrade the service; a client below the window is
told to upgrade the project's Autobuild. Diagnostics name the service version
and supported range.

Unauthenticated `GET /health` publishes `ok`, `autobuildVersion`,
`protocolVersion`, and `supportedClientRange: { minVersion, maxVersionExclusive }`.
Range endpoints remain stable versions. The range is inclusive at the minimum
and exclusive at the maximum; a 0.11.x
service publishes `>=0.9.0 <0.12.0`. Health needs no credentials, version
headers, or available backend.

`ab upgrade` probes this public range before installation or project changes.
It warns and continues when the target is outside the range, naming the
required service upgrade for a newer target or a compatible project range for
an older one. An unavailable or malformed probe warns that connectivity may
fail after upgrade. Legacy health without a range means exact-version matching;
the hosted instance must publish a compatibility window before clients can
use release-line compatibility.

A distribution fix reaches origin-mode guests after a release is cut and the
dispatcher is upgraded. Guests continue to run the dispatcher's own version;
the instance must support that release line.

Provisioning records the installed distribution's identity — package version
and remote-store protocol version — in the guest's
`/opt/autobuild/.distribution-version` marker. Every path that launches guest
code in an existing sandbox — provisioning reuse, harvest reuse, the operator
sandbox, and build execution restart after a lease sweep — compares the marker
against the identity the current system would deliver and, when they disagree
(which includes every guest provisioned before the marker existed), refreshes
it in place (archive re-fetched, extracted, and production-installed) first,
so an upgraded dispatcher retrofits its existing guests instead of resuming a
stale distribution. A refresh failure deletes
the sandbox so the next provisioning pass rematerializes it from scratch.

After a dispatcher upgrade, confirm a fix-bearing guest from the guest
perspective:

1. `ab build status <slug> --json` with the ambient build identity for a
   build whose record carries `repoOrigin` succeeds and exposes `.pr.number`
   and `.pr.url` even though the guest's checkout path differs from the path
   recorded at build creation (post-#297 origin-equality behavior).
2. The same command for a genuinely foreign repository's slug still fails
   with the `belongs to repository … not …` rejection.

Local `git-worktree` dispatch keeps working from a checkout exactly as before;
apart from the identity change, `ab dispatch` behaves as it did.

## Connect a project

From a checkout with an origin remote, run `ab connect https://YOUR_ORIGIN`.
The CLI prints a verification URL and short code and attempts to open a browser.
Sign in as an allowed owner, check the full repository identity and code, and
approve or deny. Another device can open the printed URL, or visit `/connect`
and enter the code. Approval uses the instance’s browser consent endpoint. Requests
expire after ten minutes. Denial and timeout leave local configuration unchanged.

On approval the service registers the project and issues a project credential.
The CLI keeps it in `$XDG_CONFIG_HOME/autobuild/credentials` (or
`~/.config/autobuild/credentials`), keyed by normalized service and origin,
with directory mode 0700 and file mode 0600. Credentials never belong in the
repository. It adds the non-secret `[store] url` to `autobuild.toml` when
absent; review and commit that change yourself. An existing different URL
must be changed explicitly before connecting. Reconnecting replaces the saved
credential only after approval and revokes the previous credential.

All worktrees share the main checkout's configuration and the user's saved
credential. A service manager running as that user uses the same HOME and
XDG_CONFIG_HOME, with no AB_STORE or AB_TOKEN exports. A fresh clone with
committed store configuration but no saved credential fails with `ab connect`
guidance; it never silently creates local state. Run connect on each host/user.

`ab connect` without a URL reports service, project, and credential status:
accepted, rejected, missing, or unreachable. `ab disconnect` revokes the saved
credential remotely before removing it locally, keeping the project registered,
its data, and store configuration. A network/server failure retains the local
entry for retry; an already revoked credential can be removed. If saving a new
connection fails, the CLI cancels/revokes it and retains the previous entry.
If remote cleanup cannot be confirmed, check the printed credential id with
the owner's administrative tools before retrying.

Store selection is `--store` > nonblank `AB_STORE` > `[store] url` > the
main checkout's `.autobuild/`. `AB_TOKEN` overrides the exact service/project's
saved credential for CI and other non-interactive hosts. A service override
never borrows another service's credential. Build and harvest sessions keep
their explicit scoped authority.

## Authoring an agent verifier

A repository-owned agent-verify skill is a verifier, not a reviewer: it drives
the running application and observes whether the spec's acceptance criteria
hold. It does not inspect the diff for style or edit product code.

Repository-authored finalize skills also run `ab context` and read hydrated inputs
from `$AB_CONTEXT_DIR`, using the manifest for collision-adjusted paths.

Its session instructions must preserve this contract:

Scratch output, downloaded references, probes, and temporary scripts belong under `.ab/`
(prefer the current `$AB_CONTEXT_DIR` when appropriate), never at the worktree
root, and must not be committed. Manifest-directed artifact paths remain authoritative.

Large scratch belongs under the session's `.ab/` directory (prefer `$AB_CONTEXT_DIR`),
not `/tmp`: this includes ad-hoc PostgreSQL data/cluster directories, Cargo target
directories, browser profiles, and database copies. Configure `PGDATA`,
`CARGO_TARGET_DIR`, and explicit browser profile paths for those resources.
Keep `TMPDIR` outside the worktree for test suites and commands that discover
repositories or configuration through parent directories, including focused tests
and Git probes. Do not relocate required installed tooling or retained evidence;
manifest-directed artifact paths remain authoritative. Never commit scratch.


1. Run `ab context` and read `"$AB_CONTEXT_DIR/context.json"`. The verifier receives
   `$AB_CONTEXT_DIR/spec.md`, the configured step,
   the commit range, and, after escalation is answered, `$AB_CONTEXT_DIR/guidance.json`.
   Node verify sessions also receive `nodeVerification` in the context manifest:
   contribution specs and a provenance index mapping commits to the builds that
   introduced them. Read those specs through the manifest's allocated paths.
   Also read `handPushedCommits: [{sha, originalSha, message}]` from the manifest
   and index. These hand-pushed node commit messages express maintainer-authorized
   intent; judge quality and consistency, and never fail them solely for lacking
   a covering spec. Other node changes are authorized when the node spec or the introducing
   contribution's spec covers it; use the commit index to find that spec.
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

### Project-scoped hosted tickets

Hosted ticket queues belong to the credential's registered repository, even
when projects share a team key. Independent project ticket policy owns lifecycle:
new defaults are triage / ready / doing / done, with create/proposal following
triage. Explicit names retain their spelling; doneState customizes completion.
`ab connect --tickets URL` publishes policy before dispatch. Older clients without
independent policy retain their uploaded dispatcher configuration and legacy defaults.
Owner admin requests require an explicit registered context.repo; project credentials
cannot select another project. See [local builds with hosted tickets](#local-builds-with-hosted-tickets).

The service never contacts Linear. Projects with external sources (including
file and Linear) keep using those sources directly through their dispatcher;
service ticket HTTP and operator surfaces refuse with project/source
feedback rather than returning an empty queue.

## Local builds with hosted tickets

Hosted tickets do not require hosted builds. Set `[tickets] source = "hosted"`
and `teamKey = "ENG"`, then run `ab connect --tickets https://your-service.example`.
Approve the project in the browser. This saves a service-scoped credential and
`[tickets] url` while leaving `[store]` unchanged. Ticket commands work immediately,
before any dispatcher runs. `ab connect` reports every service and whether it serves
builds, tickets, or both. Use `ab disconnect --tickets` to revoke ticket access;
when services differ use `--builds` to select build access. Shared uses share one
credential, so disconnecting either shared use affects both.

Ticket URL selection is `[tickets] url`, then the selected build service (including
AB_STORE or a supported --store override). With local builds, `[tickets] url` is
required. Builds, events, artifacts, and harvest journals remain in the local store.
The service stores ticket records, project ticket policy, and restricted ticket
grants. Normal project clients synchronize current `[tickets]` policy before use;
failed synchronization fails the operation. Harvest grants can read and create;
phase grants can only read. Neither can change policy or access BuildStore routes.

New hosted policy defaults to `triage`, `ready`, `doing`, `done`, with creation and
harvest proposals in `triage`. Explicit state names preserve their spelling.
To retain earlier names configure `triageState = "Backlog"`,
`claimedState = "Doing"`, `doneState = "Done"`, and the desired `readyState`.
Existing ticket rows are never renamed. Older combined-service clients continue
using the uploaded dispatcher configuration until independent policy is published.

## Forge readiness

Validation inspects the configured forge once on the host, including when builds
run in Vercel Sandbox. Forge credentials never enter the guest. Each setting is
PASS, FAIL, WARN, or UNKNOWN; unknown never means permission was proved.

For GitHub, enable **Allow squash merging** and **Allow rebase merging** in
Settings → General. The kernel needs direct publication and force-push permission
throughout `refs/heads/ab/` and `refs/heads/ab-node/`, including future branch
names. It also publishes immutable `refs/autobuild/archive/` refs, a non-head
namespace. Review protection rules, inherited organization rulesets, push rules,
and actor restrictions for all three namespaces. GitHub's branch APIs cannot
prove archive-domain access: manually verify it with your administrator without
creating probe refs or overwriting archives. Autobuild never changes settings or
performs test pushes.

Require **linear history** on protected root and node target branches to prevent
merge commits from GitHub's update-branch action. On the configured root, enable
**Require branches to be up to date before merging**, with nonempty required
checks enforced for all merge actors. This makes root node merges fenced;
without it they are best-effort. Both are recommendations, so missing settings
produce warnings rather than hard failures.

Inspection needs **Metadata:read** for rulesets and **Administration:read** for
classic protection; classic private-repository tokens need `repo` access.
Publication separately needs **Contents:write**. Read access never proves write
access. Insufficient scope, incomplete inventories, ambiguous patterns, or
unproven actor bypass produce UNKNOWN with access/remediation guidance. Plugins
without the optional readiness capability report UNKNOWN and need an adapter
upgrade; local Git passes these hosted-policy checks trivially.

Known hard failures make `ab init --validate` exit unsuccessfully. Warnings and
unknowns preserve the workspace validation result and require your review.
Dispatch reports known hard failures once per invocation as durable
`dispatcher.forge-readiness-failed` repository notices without adding an admission
gate. External orchestrators follow these through `ab watch` with no slugs or an
explicit repository watch; `ab wait` remains build-only. The dashboard and operator
repository query retain all failures for that run. After correcting settings or
access, revalidate and restart dispatch to refresh its startup diagnostics.

Changing the connected ticket source does not itself migrate in-flight builds.
Follow [ticket migration](ticket-migration.md), keeping the existing BuildStore
and recording continuity before resuming build-related ticket writes.
