import { renderSiteHeader } from './site-header'
import { INSTALL_COMMAND, REPO_URL, SITE_URL } from './constants'
import { OG_HEIGHT, OG_IMAGE_ALT, OG_WIDTH } from './og'

export interface DocsPage {
  group: 'start' | 'concepts' | 'guides' | 'reference'
  path: string
  file: `${string}.html`
  label: string
  title: string
  description: string
  content: string
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const reference = (path: string, label: string): string =>
  `<a href="${REPO_URL}/blob/main/${path}">${label}</a>`
const command = (text: string): string =>
  `<pre class="terminal"><code>${escapeHtml(text)}</code></pre>`

/** Add a page here to emit its HTML and include it in every docs navigation. */
export const DOCS_PAGES: readonly DocsPage[] = [
  {
    path: '/docs/',
    file: 'docs/index.html',
    label: 'Overview',
    group: 'start',
    title: 'How Autobuild works',
    description:
      'The ticket-driven development lifecycle, its review and verification gates, and the repositories it fits.',
    content: `
<p>Autobuild takes a groomed ticket through planning, implementation, review, verification, and pull request creation. It runs coding agents inside a fixed pipeline, with a separate workspace for each build. Humans decide what to build and answer escalations.</p>
<h2>From a ticket to a change</h2>
<p>A ticket starts with the observable change, why it matters, acceptance criteria, explicit limits, and evidence. Grooming turns those decisions into a buildable spec and moves the ticket to the tracker's configured ready state. Writing a ticket alone does not make it ready to build.</p>
<p>The dispatcher claims ready tickets and starts builds up to your configured capacity. Each work ticket runs the same pipeline:</p>
<ol>
<li><strong>Spec.</strong> Establish the ticket's spec as the contract for the build.</li>
<li><strong>Plan and plan review.</strong> An agent proposes an implementation plan. An independent reviewer checks it against the spec and can request revisions.</li>
<li><strong>Implement and code review.</strong> An agent commits the change. A fresh reviewer checks the implementation; findings send it back for another round.</li>
<li><strong>Verify.</strong> Your configured checks run in order. They can be commands or agent verifiers. A failed check returns the build to implementation.</li>
<li><strong>Finalize.</strong> An agent writes the pull request description and Autobuild opens the PR.</li>
</ol>
<p>Landing still depends on the configured policy and merge gates. If the PR conflicts, reconciliation is followed by verification again. A green build is not a promise of immediate merge. Related work can also be collected into an integration tree before landing.</p>
<h2>Agents judge; code moves the build</h2>
<p>Agents plan, implement, and review. Deterministic code owns transitions, state, gating, and publication. Every phase reports through the typed CLI; agent output alone never decides whether a phase succeeded.</p>
<p>Build state comes from a typed, append-only event log. Artifacts and feedback are stored with the build, so resumption uses durable state rather than a continuing chat. Open escalations remain parked until an answer is recorded.</p>
<p>For the full model, read the ${reference('SPEC.md', 'design specification')} and ${reference('docs/architecture.md', 'architecture map')}.</p>
<h2>Where it fits</h2>
<p>Autobuild fits repositories where work can be described as clear tickets and checked with useful automated verification. You need Bun, git, and the prerequisites for your selected agent runtime: Claude Code, Codex CLI, or Pi. Runtime access and credentials are part of your setup.</p>
<p>It favors throughput over the latency of one change: independent builds can run side by side, while each still pays for planning, review, and verification. A small edit that needs an immediate answer may be better handled directly in your coding agent.</p>
<p>It does not replace product decisions or make vague tickets precise without your input. If you cannot state what done means, or your checks cannot detect a broken change, grooming and verification need attention first. Builds can stop for escalation answers; unattended execution does not remove the operator's responsibility.</p>
<h2>Using these docs</h2>
<p>Start with <a href="/docs/getting-started/">Getting started</a> for installation and a first ticket. These pages introduce the system for engineers evaluating it. Read about <a href="/docs/builds/">builds</a>, the <a href="/docs/dispatcher/">dispatcher</a>, <a href="/docs/integration/">integration</a>, and <a href="/docs/tickets/">tickets</a>, plus <a href="/docs/operating/">Operating</a>, <a href="/docs/seams/">Seams</a>, and <a href="/docs/configuration/">Configuration</a>; the repository holds the detailed references.</p>
<p>The ${reference('docs/configuration.md', 'configuration reference')} describes what you configure. The ${reference('docs/spec-standard.md', 'spec standard')} defines a buildable ticket.</p>`,
  },
  {
    path: '/docs/getting-started/',
    file: 'docs/getting-started/index.html',
    label: 'Getting started',
    group: 'start',
    title: 'Getting started',
    description:
      'Install Autobuild in your repository, configure it with ab init, groom a ticket, and start the dispatcher.',
    content: `
<p>Start in the repository you want Autobuild to build. You need <a href="https://bun.sh">Bun</a>, git, and the local prerequisites for the agent runtime you select: Claude Code, Codex CLI, or Pi.</p>
<p>The GitHub forge needs an authenticated <a href="https://cli.github.com">gh CLI</a> or an exported <code>GITHUB_TOKEN</code> or <code>GH_TOKEN</code>. The local-git forge needs no account or remote. Setup will help choose the arrangement for your repository.</p>
<h2>1. Install in the repository</h2>
${command(INSTALL_COMMAND)}
<p>This adds Autobuild as an exact development dependency. If installation creates <code>package.json</code> and <code>bun.lock</code>, commit them and ignore <code>node_modules/</code>. Run the repository-installed CLI with <code>bun ab</code>.</p>
<h2>2. Initialize and configure</h2>
${command('bun ab init')}
<p>Initialization vendors the editable <code>ab-*</code> skills, writes a stack-neutral <code>autobuild.toml</code>, and hands repository-aware setup to a coding agent. Follow that handoff to choose a runtime and model, ticket tracker, forge, workspace, and meaningful verification commands for your stack.</p>
<p>Review the generated configuration and skills as repository files. Setup must establish the tools and credentials your chosen adapters need; installation alone does not configure a working pipeline. The ${reference('docs/configuration.md', 'configuration reference')} covers every field.</p>
<h2>3. Groom the first ticket</h2>
<p>Open your coding agent in the repository and invoke the installed <code>ab-spec</code> skill. For an example request, use the invocation for your runtime:</p>
<ul>
<li>Claude Code: <code>/ab-spec add a retry budget</code></li>
<li>Codex: <code>$ab-spec add a retry budget</code></li>
<li>Pi: <code>/skill:ab-spec add a retry budget</code></li>
</ul>
<p>The agent asks questions, develops acceptance criteria, records scope and evidence, and files the ticket in your configured tracker. Decide what the change should do, then groom it to the tracker's configured ready state. A draft or triage ticket is not dispatchable just because it exists.</p>
<p>Keep the first change small enough to review and give it checks that can demonstrate success. Use the ${reference('docs/spec-standard.md', 'spec standard')} to assess whether the ticket is buildable.</p>
<h2>4. Start dispatch</h2>
${command('bun ab dispatch')}
<p>The dispatcher claims ready work and shows a live dashboard. The README quickstart starts dispatch before grooming; either order works because the dispatcher claims ready tickets as they arrive.</p>
<p>Each claimed work ticket gets an isolated build and moves through planning, review, implementation, verification, and PR creation. Watch the build's recorded state. When it escalates, an operator must answer the question before it can continue. Merge still follows the configured landing policy and gates.</p>
<p>For deeper reference, read the ${reference('docs/configuration.md', 'configuration reference')}, ${reference('docs/architecture.md', 'architecture map')}, and ${reference('SPEC.md', 'design specification')}. Return to the <a href="/docs/">overview</a> for the lifecycle and its limits.</p>`,
  },
  {
    path: '/docs/builds/',
    file: 'docs/builds/index.html',
    label: 'Builds',
    group: 'concepts',
    title: 'One build, end to end',
    description:
      'Follow a work ticket through planning, review, verification, pull request creation, and landing.',
    content: `
<p>A build is one execution for one ticket, identified by a slug. A work ticket follows the fixed pipeline: <code>spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize</code>. Integration nodes have a <a href="/docs/integration/">different lifecycle</a> for collecting related changes.</p>
<h2>The spec is the contract</h2>
<p>Grooming establishes what to build before execution. At dispatch, Autobuild pins a conforming spec as a stored artifact. <code>spec</code> names that contract, not another agent phase. Planning, review, and verification judge the change against it.</p>
<p>Ordinary execution uses the pinned spec rather than rereading mutable tracker text. If the contract needs to change, an escalation lets an operator record a revised spec and restart from planning.</p>
<h2>Produce, then review</h2>
<p>The planner proposes an implementation plan. A plan reviewer checks it against the spec. Once approved, the implementer makes local commits, and a code reviewer checks the change against the spec and plan. Either reviewer can approve, request revisions with structured findings, or escalate a question.</p>
<p>Each agent phase starts in its own session. Within a review loop, the producer continues across rounds while each reviewer gets a fresh session. The spec, approved plan, implementation notes, findings, and verification reports carry context between phases as durable artifacts. A build does not depend on one agent remembering the whole conversation.</p>
<p>Review loops have a configured review-round ceiling. They also have a stall limit: when a reviewer marks the same finding as persisting across enough rounds, deterministic code escalates the disagreement. Reaching either limit parks the build for an answer instead of spending rounds indefinitely. An operator can replace the ceiling for the parked loop and current spec revision.</p>
<h2>Verify, then publish</h2>
<p>After code review approves, Autobuild prepares the build's single net change on the sampled destination and runs the configured <code>verify:*</code> steps in order. A check verifier runs a command and uses its exit code. An agent verifier inspects evidence and records a pass, failure report, or explicit skip reason. Applicability rules can also skip a step with a recorded reason.</p>
<p>A failed verifier returns the work build to implementation with its report, followed by code review and verification again. Once verification succeeds, the finalize agent writes the pull request description; Autobuild handles publication and opens the PR.</p>
<p><code>verify:*</code> and <code>finalize:*</code> are the only configurable extension points. Optional <code>finalize:*</code> post-steps run after PR creation, for tasks such as a changelog or ticket link. They are failure-tolerant: a failed post-step records an observation rather than killing a green build. The core phase order stays fixed.</p>
<h2>When a human is needed</h2>
<p>After grooming, escalations are the pipeline's human judgment gates. An unclear requirement, a persistent review disagreement, or an exhausted policy bound can park the build with a recorded question. The operator records retry guidance or an answer through the CLI or operator tools. Restarting dispatch does not answer that question, and an answer does not force success.</p>
<p>Landing consent is a separate policy decision: repositories can require it even for a green build. Verification, forge checks, and merge gates still apply. See <a href="/docs/integration/">integration and landing policy</a>.</p>
<h2>The reconcile epilogue</h2>
<p>After finalize, Autobuild continues watching the destination. A clean restack onto a newer base is automatic and starts no agent. A conflicted replay enters <code>reconcile</code>: an agent resolves the kernel-prepared change on a frozen refreshed base, then the configured post-reconcile verification runs. This epilogue repeats as needed until the PR is merged or closed.</p>
<p>The ${reference('SPEC.md', 'design specification')} defines the pipeline and review limits. Read the ${reference('docs/architecture.md', 'architecture map')} for its boundaries and the ${reference('docs/restacking.md', 'restacking reference')} for replay and verification details. The <a href="/docs/dispatcher/">dispatcher guide</a> explains how builds run and resume.</p>`,
  },
  {
    path: '/docs/dispatcher/',
    file: 'docs/dispatcher/index.html',
    label: 'Dispatcher',
    group: 'concepts',
    title: 'The dispatcher and durable state',
    description:
      'How Autobuild claims ready tickets, runs isolated builds within capacity, and resumes from its event log.',
    content: `
<p>The dispatcher watches your configured ticket source for ready work. It claims eligible tickets, establishes their specs, and starts isolated build-runners up to the repository's capacity. Agents supply judgment inside the pipeline; deterministic code decides what runs next.</p>
<h2>Ready work becomes a build</h2>
<p>The ready gate combines the configured workflow state with any required labels and source-specific filters. A ticket must also satisfy its blockers and destination checks before claim. Work that cannot yet start stays queued. The <a href="/docs/tickets/">tickets guide</a> explains grooming and intake.</p>
<p>Each work build runs in its own workspace: a local git worktree or a remote sandbox, depending on the selected workspace provider. Its build-runner owns the pipeline execution, keeping concurrent builds isolated. Capacity bounds concurrent execution; it does not make every queued ticket runnable at once.</p>
<p>An integration node can collect children without an active runner or workspace. Idle collecting nodes consume no runner capacity; node verification temporarily uses execution capacity. See <a href="/docs/integration/">the integration tree</a>.</p>
<h2>The log is the source of truth</h2>
<p>Build processes append typed facts to a per-build, append-only event log in the BuildStore. Repository-wide workflows and operator settings use a separate repository journal. Specs, plans, reports, and other artifacts live with that durable record.</p>
<p>State is reduced from events. A snapshot is only a cache that can be regenerated from the log. Agent stdout never determines a phase outcome: agents report through the typed <code>ab</code> CLI, and code validates deposits, applies gates, and records transitions.</p>
<h2>Resume the work, not the chat</h2>
<p>Running dispatch again recovers actionable current work from durable state. The runner reads the recorded phase, completed boundaries, artifacts, and feedback rather than needing a process or conversation to have survived. A replacement sandbox can resume the same build.</p>
<p>Recovery does not erase a human gate. An unanswered escalation stays parked until an operator records an answer. Pending operator commands and other actionable work can still proceed; restarting the dispatcher does not grant permission or reset an exhausted budget.</p>
<h2>The operator stays outside</h2>
<p>The operator can be a human or an external coding agent acting as orchestrator. It files and grooms tickets, watches builds, answers escalations, and manages landing consent. Locally it uses the CLI; an agent connected over MCP can use the corresponding operator tools.</p>
<p>Autobuild does not host or start that orchestrator agent. It runs the build pipeline and exposes durable state and controls for the operator to use. The operator's chat is separate from the build's paper trail.</p>
<p>Read the ${reference('docs/architecture.md', 'architecture map')}, ${reference('docs/operator-api.md', 'operator API reference')}, and ${reference('docs/integration-tree.md', 'integration-tree reference')} for the process and control boundaries. Follow <a href="/docs/builds/">one build end to end</a> for the phases inside a runner.</p>`,
  },
  {
    path: '/docs/integration/',
    file: 'docs/integration/index.html',
    label: 'Integration',
    group: 'concepts',
    title: 'Integrating related work',
    description:
      'Collect work in an integration tree, preserve change identity through restacks, and land under explicit policy.',
    content: `
<p>Autobuild organizes work as a tree rooted at your configured <code>baseBranch</code>. Work tickets are leaves. Node tickets are finite integration points that collect children before landing into their parent. A repository can also send every work ticket directly to the root.</p>
<h2>Targets form the tree</h2>
<p>A node opens an <code>ab-node/&lt;slug&gt;</code> branch at its parent's sampled head. Nodes can nest. A work ticket targets a node by ticket id, or defaults to the root when its target is omitted. Claim freezes the destination build generation and branch; editing a claimed work ticket cannot silently redirect its change.</p>
<p>Leaves run the <a href="/docs/builds/">normal build pipeline</a>. Nodes instead collect, verify, land, and close. A node finishes collecting when its targeting tickets are done or cancelled, frozen child claims have settled, and at least one contribution has landed. Idle nodes need no runner, and empty nodes have no PR.</p>
<p>Node verification checks the exact node head and parent. A change to either invalidates landing eligibility and requires verification again, even after a clean restack. A failed node check can be repaired by a child ticket targeting that node. A landed node closes admission; it is not a perpetual staging branch.</p>
<h2>One identity per leaf change</h2>
<p>A leaf contributes one canonical net change, however many implementation commits it took. The <code>Autobuild-Build: &lt;slug&gt;</code> trailer carries its identity across commit SHA rewrites. Root leaf squash landings retain that identity, and node integration preserves the ordered contributing identities. A whole node does not become one leaf commit.</p>
<p>Autobuild restacks changes when their destination moves and cascades parent movement through descendants. Clean replay is automatic. A conflict attaches a reconcile runner with the source change's context, followed by verification as required. Nodes always reverify a changed head or parent; a clean waiting leaf restack can retain its prior verification, whose reports keep their actual head and base citations.</p>
<h2>Blockers are a separate graph</h2>
<p>A target says where work integrates. A blocker says which prerequisite must be available before dependent work can start. In repositories with nodes, a blocker that has a build resolves when its change is present in the dependent's sampled destination, rather than merely when the source ticket says done.</p>
<p>Presence is checked at claim, without interrupting existing builds. Sibling work may need to land into a common ancestor and cascade before it is available. Missing or ambiguous evidence keeps the dependent queued. Repositories without nodes, and blockers without builds, use the source's native done-state resolution.</p>
<h2>Policy authorizes landing</h2>
<p>Ordered <code>[[landing]]</code> rules in <code>autobuild.toml</code> select <code>auto</code> or <code>consent</code>. Rules can match the source kind, destination, and ticket label; the first matching rule wins. Without a match, leaves default to auto and nodes to consent.</p>
<p><code>ab land &lt;slug&gt;</code> requires readiness, clears a hold, and records consent to the landing. <code>ab hold &lt;slug&gt;</code> can suppress landing before readiness and withdraw consent. Neither these controls nor automatic authorization bypass readiness, verification, forge checks, protection, or merge gates.</p>
<p>Read the ${reference('docs/integration-tree.md', 'integration-tree reference')} for admission and node lifecycle, the ${reference('docs/restacking.md', 'restacking reference')} for change identity and recovery, and the ${reference('docs/landing-policy.md', 'landing-policy reference')} for rules and forge requirements. The <a href="/docs/tickets/">tickets guide</a> explains the input side of the tree.</p>`,
  },
  {
    path: '/docs/tickets/',
    file: 'docs/tickets/index.html',
    label: 'Tickets',
    group: 'concepts',
    title: 'Tickets are the interface',
    description:
      'Choose a ticket source, groom buildable specs, and admit proposed work through the ready gate.',
    content: `
<p>A ticket tells Autobuild what change to make and why it matters. Grooming turns that intent into a buildable spec. The tracker is the input interface; the build's pinned spec is the execution contract.</p>
<h2>Choose a source</h2>
<p>Autobuild ships file, direct Linear, and hosted ticket sources. The file source stores tickets in lifecycle directories. Direct Linear uses your team's workflow. Hosted tickets are their own project-scoped service, not a proxy for Linear. Plugins can register additional ticket sources through the same port.</p>
<p>The source supplies ticket content, workflow states, labels, and blockers. Configuration chooses the source and ready gate; the rest of the build pipeline keeps the same vocabulary and behavior.</p>
<h2>Groom a buildable spec</h2>
<p>The spec standard asks for four things:</p>
<ul>
<li><strong>What and why.</strong> Describe the observable change and the reason it matters. Leave implementation strategy to planning.</li>
<li><strong>Acceptance criteria.</strong> State verifiable facts that a reviewer or check can use to decide whether the work is done.</li>
<li><strong>Out of scope.</strong> Name adjacent work the build must leave alone.</li>
<li><strong>Evidence.</strong> Link the decision, incident, data, or observations supporting the request.</li>
</ul>
<p>A human grooms the ticket and moves it to the configured ready state with any required labels. Being present in a tracker is not enough. Dispatch's spec gate returns ready tickets that cannot become conforming specs to Triage with an explanation.</p>
<h2>Ready is a gate, not a guarantee</h2>
<p>The dispatcher claims only tickets meeting the configured ready state and label requirements, plus any source-specific filter. Unresolved blockers leave a ticket queued rather than creating a blocked build. Destination availability and execution capacity also affect when it can start.</p>
<p>Blockers are distinct from a build escalation. They describe prerequisites between tickets. In a node-enabled repository, prerequisites with builds must be present at the sampled destination; see <a href="/docs/integration/">integration and blocker presence</a>.</p>
<p>At dispatch, Autobuild pins the spec for the build. Changing tracker text later does not quietly change what its reviewers approved. A deliberate spec revision requires an operator answer to an escalation and restarts planning.</p>
<h2>Intake proposes work</h2>
<p>Anything that can write a ticket can propose work from an outside signal. Autobuild's shipped observation harvest collects discoveries agents record while staying within their current spec, synthesizes proposals, reviews them, and files approved tickets. Harvest is a repository workflow, not another build phase.</p>
<p>Proposals default to the configured Triage state for a human to groom before dispatch. A repository can explicitly waive that harvest grooming gate with <code>[tickets].proposalState</code>, including choosing its ready state. That waiver does not waive blocker eligibility or the dispatch spec gate.</p>
<p>Scheduled ingesters for signals such as telemetry remain proposed extensions; they are not shipped integrations. A signal is evidence for a proposal, not permission to dispatch work.</p>
<p>Read the ${reference('docs/spec-standard.md', 'spec standard')}, ${reference('docs/configuration.md', 'ticket-source configuration reference')}, and ${reference('SPEC.md', 'design specification')} for the full contract and intake model. Follow the <a href="/docs/dispatcher/">dispatcher guide</a> to see what happens at claim, or <a href="/docs/getting-started/">Getting started</a> to groom a first ticket.</p>`,
  },
  {
    path: '/docs/operating/',
    file: 'docs/operating/index.html',
    label: 'Operating',
    group: 'guides',
    title: 'Operating Autobuild',
    description:
      'Watch durable progress, answer escalations, pause work, and authorize landing through the CLI or an external operator agent.',
    content: `
<p>The operator keeps work moving: watch recorded progress, answer questions, and decide when consent-gated changes may land. An operator can be a human or an external coding agent. Autobuild does not start or host an orchestrator agent.</p>
<h2>Watch for attention</h2>
${command('bun ab watch --json')}
<p>This standing monitor follows active builds, newly created builds, and the repository journal. Its default filter reports actionable attention, including escalations and ready landings that need consent. Use event filters when you want routine lifecycle events too. A fresh watch starts from now; inspect current status as well to reconcile attention that already exists.</p>
<p>Save the opaque cursor from the JSON output and pass it back with <code>--since</code> to resume through events recorded while the monitor was away. The final JSON line carries a cursor even when no event matched. The default watch duration is 30 minutes; <code>--timeout 0</code> keeps it open.</p>
${command('bun ab wait my-build --for attention --json --timeout 5m')}
<p><code>wait</code> is a bounded, one-shot wait for a build condition. It exits 0 on a match, 2 if all named builds end without matching, and 3 on timeout. Existing attention returns immediately, even with a cursor, so repeatedly waiting for the same current condition is not an event-consumption loop. Use <code>watch --since</code> for that.</p>
<h2>Answer and pause</h2>
${command('bun ab answer my-build "Keep the public API compatible"')}
<p>An open escalation parks work until an answer is recorded. Guidance becomes input to the next round. The answer command also supports a bare retry and explicit revised-spec resolutions when the contract itself needs to change; consult CLI help and the ${reference('SPEC.md', 'design specification')} before choosing a resolution.</p>
${command('bun ab pause my-build\nbun ab resume my-build')}
<p>Pause requests stop a build at its supported boundary; resume releases a cleanly paused build. Resume does not answer an escalation. <code>bun ab pause --all</code> holds queued work, turns intake off, and requests pauses on running builds. <code>bun ab resume --all</code> releases that hold, enables intake, and resumes cleanly paused builds.</p>
<p>Turning intake off alone stops new ticket claims. Repository pause also holds queued builds. Neither action withdraws landing consent: use a hold when the intended action is to stop a landing.</p>
<h2>Authorize landing</h2>
<p>Ordered landing rules select automatic authorization or explicit consent. Without a matching rule, leaves default to auto and integration nodes to consent. Authorization always remains subject to verification, checks, protection, and merge gates.</p>
${command('bun ab land my-build\nbun ab hold my-build')}
<p><code>land</code> requires a ready build, clears its hold, and grants consent to land into its destination. <code>hold</code> suppresses landing and revokes consent, even before readiness. Consent survives head changes, restacking, verification, and re-finalization until hold or completion; accepted node reparenting revokes it. Review the ${reference('docs/landing-policy.md', 'landing policy reference')} for the exact readiness and forge requirements.</p>
<h2>Choose an operator surface</h2>
<p>The live terminal dashboard shown by <code>bun ab dispatch</code> and the hosted web operator app both read durable state. They expose build progress, escalations, and pause/resume controls. The web app also lets you inspect sessions and transcripts. Landing consent and hold are available through the CLI, terminal keys <code>l</code>/<code>o</code>, and MCP/operator tools; the web app has no consent controls.</p>
<p>Any external agent with shell access can operate through the CLI. <code>bun ab mcp</code> serves the operator tools locally over stdio. The hosted service exposes its authenticated <code>/mcp</code> connector for agents running elsewhere, without requiring a repository checkout on the operator's machine.</p>
<p>Read the ${reference('docs/operator-api.md', 'operator API reference')} and ${reference('docs/mcp.md', 'hosted MCP guide')} for remote access. The ${reference('SPEC.md', 'design specification')} records the CLI and escalation contracts.</p>`,
  },
  {
    path: '/docs/seams/',
    file: 'docs/seams/index.html',
    label: 'Seams',
    group: 'reference',
    title: 'Infrastructure seams',
    description:
      'Choose stores, agent runtimes, forges, workspaces, and ticket sources, and understand where local and remote execution run.',
    content: `
<p>Autobuild separates the pipeline from the infrastructure that runs it. Adapters supply storage, agent execution, code publication, workspaces, and tickets. Choose each responsibility explicitly; selecting a remote database does not move computation to a remote machine.</p>
<h2>Storage and tickets</h2>
<p>The default local BuildStore uses SQLite and filesystem artifacts. A separate Postgres adapter provides database-backed storage. The hosted HTTP service exposes a network-accessible Store backed by Postgres. A storage adapter and the service that exposes it are distinct parts of a deployment.</p>
<p>Ticket sources are selected independently of the BuildStore: local files, Linear, or hosted tickets. Using a hosted Store does not require using hosted tickets. See the ${reference('docs/architecture.md', 'architecture map')} and ${reference('docs/hosted-service.md', 'hosted service reference')} for the boundaries.</p>
<h2>Agents, code, and workspaces</h2>
<ul>
<li><strong>Agent runtimes.</strong> Claude Code, Codex, and Pi are shipped adapters. Roles choose runtimes and models. Model selection does not itself decide where an agent runs.</li>
<li><strong>Forges.</strong> GitHub and local git are shipped adapters. Local git permits local operation without GitHub pull requests; it does not supply the GitHub publication path required by the remote setup.</li>
<li><strong>Workspaces.</strong> Local builds use disposable git worktrees. Vercel Sandbox provisions remote machines for build runners, agents, and checks.</li>
</ul>
<p>Each environment needs the selected runtime, tools, dependencies, and credentials. Remote execution also needs provisioning and reproducible setup. Follow the ${reference('docs/setup.md', 'setup reference')} for the supported adapter combinations and readiness checks.</p>
<h2>What runs where</h2>
<p><strong>All local.</strong> The operator's machine runs the dispatcher, build runners, agent runtime CLIs, checks, git worktrees, and local Store. File tickets and the local-git forge can keep this arrangement independent of GitHub. You can watch dispatch in the terminal and operate through the local CLI.</p>
<p><strong>All remote.</strong> A hosted scheduled dispatcher uses origin-mode repository configuration. Vercel Sandbox runs build runners, agents, and checks; GitHub holds code and receives publication. A hosted Store backed by Postgres records progress, and a remote ticket source supplies work. Operators use the browser or MCP connector. The operator agent remains external. Provisioning and credentials are still required; this is not enabled merely by choosing Postgres.</p>
<p>Mixed deployments are supported within adapter constraints, such as a local dispatcher using a hosted Store and remote sandboxes. The ${reference('docs/hosted-dispatcher.md', 'hosted dispatcher reference')} explains scheduled operation; the ${reference('docs/setup.md', 'setup reference')} covers placement and credentials.</p>
<h2>Extend the boundaries</h2>
<p>Configured plugin modules can register ticket sources, agent runtimes, workspace providers, and forges. BuildStore extensions use the storage adapter or remote protocol contract, rather than a plugin manifest registration.</p>
<p>Ordered verify and finalize steps and editable skills extend repository behavior while the phase grammar stays fixed. See <a href="/docs/configuration/">Configuration</a> and the ${reference('docs/configuration.md', 'full configuration reference')} for plugin modules and extension points.</p>`,
  },
  {
    path: '/docs/configuration/',
    file: 'docs/configuration/index.html',
    label: 'Configuration',
    group: 'reference',
    title: 'Repository configuration',
    description:
      'Map autobuild.toml settings to verification, agent roles, capacity, ticket readiness, landing policy, and editable skills.',
    content: `
<p><code>autobuild.toml</code> declares how your repository runs Autobuild. It chooses infrastructure, commands, agent roles, checks, and operating limits. Use the ${reference('docs/configuration.md', 'full configuration reference')} for every field and its defaults; this page maps the choices you need to make.</p>
<h2>Commands and extension steps</h2>
<p>Named commands define repository tasks. Verification is an ordered list of deterministic command checks or agent verifiers. A repository can also declare optional verify steps for a build's plan to select when relevant.</p>
<p>Finalize post-steps run after PR creation, for work such as updating a changelog. A failed finalize post-step is recorded without failing an otherwise green build. Verify and finalize are the configurable extension points; configuration does not introduce arbitrary phases or reorder the fixed pipeline.</p>
<h2>Roles, models, and limits</h2>
<p>Agent roles inherit runtime and model settings from <code>roles.default</code> and can override them for a particular job. Ordered alternates provide a declared fallback chain when a provider is unavailable. Choose agents for planning, implementation, review, and agent steps according to the work each role does.</p>
<p>Capacity bounds concurrent work. Policy limits bound review rounds, retries, and session budgets, defining when automation must stop for attention. These limits complement useful checks and clear specs; they do not establish correctness themselves.</p>
<h2>Admission and landing</h2>
<p>Ticket settings choose the source and readiness criteria the dispatcher uses to admit work. Landing rules are ordered and first-match: predicates select automatic authorization or explicit consent for a source and destination. The ${reference('docs/landing-policy.md', 'landing policy reference')} describes defaults, readiness, and forge gates. See <a href="/docs/operating/">Operating</a> for consent and hold commands.</p>
<p>Build execution configuration is pinned for reproducibility, while dispatcher policy and role settings have live reload behavior. Consult the ${reference('docs/configuration.md', 'configuration reference')} for the boundary before changing settings during a build. Keep secrets outside committed TOML.</p>
<h2>Editable skills and installation</h2>
<p>The vendored <code>ab-*</code> skills are repository files you can edit. They supply agent judgment: how to plan, implement, review, and operate in your project. Code still owns transitions, state, and gates. Customizing a skill does not replace those deterministic checks.</p>
${command('bun ab init\nbun ab init --validate')}
<p><code>init</code> writes a stack-neutral configuration when absent, vendors skills, and hands repository-aware setup to a coding agent. It preserves existing configuration. Setup chooses meaningful commands and establishes adapter prerequisites; init does not invent checks from your stack. <code>init --validate</code> checks readiness for the configured arrangement.</p>
${command('bun ab upgrade')}
<p><code>upgrade</code> updates the installation on its distribution channel and merges upstream skill changes with repository edits, surfacing conflicts for resolution. It preserves customization rather than blindly replacing the installed skills. See the ${reference('docs/setup.md', 'setup reference')} and ${reference('SPEC.md#163-skill-installation-vendored-namespaced-editable-d11', 'skill installation contract')} for installation, validation, and upgrade details.</p>`,
  },
]

export function renderDocsPage(page: DocsPage): string {
  const title = `${page.title} · Autobuild docs`
  const url = `${SITE_URL}${page.path}`
  const nav = renderDocsNavigation(page)
  const prepared = prepareHeadings(page.content)
  const toc = renderToc(prepared.headings)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="canonical" href="${escapeHtml(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Autobuild">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(page.description)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${SITE_URL}/og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${OG_WIDTH}">
<meta property="og:image:height" content="${OG_HEIGHT}">
<meta property="og:image:alt" content="${escapeHtml(OG_IMAGE_ALT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(page.description)}">
<meta name="twitter:image" content="${SITE_URL}/og.png">
<meta name="twitter:image:alt" content="${escapeHtml(OG_IMAGE_ALT)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&amp;display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body class="docs" id="top">
<a class="skip-link" href="#content">Skip to content</a>
${renderSiteHeader('docs', nav)}
<div data-docs>
<div class="docs-inline-toc"><button type="button" data-toc-toggle aria-expanded="true" aria-controls="docs-sections">On this page <span aria-hidden="true">▾</span></button><div id="docs-sections">${toc}</div>${docsRule()}</div>
<div class="docs-shell">
<nav class="docs-nav docs-sidebar" aria-label="Documentation">${nav}</nav>
<main id="content" tabindex="-1"><article><div class="docs-eyebrow">${page.group} · ${escapeHtml(page.label.toLowerCase())}</div><div class="docs-title-row"><h1 class="headline">${escapeHtml(page.title)}</h1><button type="button" class="docs-copy" data-docs-copy data-markdown-exclude>Copy as Markdown</button></div><span class="docs-copy-status" data-copy-status data-markdown-exclude role="status" aria-live="polite" aria-atomic="true"></span>${prepared.html}</article>${docsRule()}${renderPager(page)}</main>
<aside class="docs-toc docs-sidebar" aria-label="Page sections"><b>On this page</b>${toc}${docsRule()}<a href="${REPO_URL}/blob/main/${DOCS_SOURCE}">Edit this page ↗</a><a href="#top">Back to top ↑</a></aside>
</div>
<footer class="docs-footer">${docsRule()}<div><span>Autobuild · Apache-2.0</span><span><a href="/">Home</a> <a href="${REPO_URL}">GitHub ↗</a></span></div></footer>
</div>
<script type="module" src="/site.js"></script>
</body>
</html>
`
}

/** Current articles are authored together; keep source mapping explicit for future extraction. */
export const DOCS_SOURCE = 'packages/website/src/docs.ts'
export const REPO_REFERENCES = [
  ['SPEC.md', 'Design spec'],
  ['docs/architecture.md', 'Architecture map'],
  ['docs/configuration.md', 'Configuration reference'],
  ['skills/guide/references/spec-standard.md', 'Spec standard'],
] as const

export function docsRule(): string {
  return `<div class="docs-rule" aria-hidden="true">${'─'.repeat(200)}</div>`
}

export function renderDocsNavigation(
  page: DocsPage,
  pages: readonly DocsPage[] = DOCS_PAGES,
): string {
  const groups = [...new Set(pages.map((entry) => entry.group))]
  return (
    groups
      .map(
        (group) =>
          `<div class="docs-group"><div class="docs-group-label">${group}/</div>${pages
            .filter((entry) => entry.group === group)
            .map(
              (entry) =>
                `<a href="${escapeHtml(entry.path)}"${entry.path === page.path ? ' aria-current="page"' : ''}><span class="docs-marker" aria-hidden="true">${entry.path === page.path ? '&gt;' : ' '}</span><span>${escapeHtml(entry.label)}</span></a>`,
            )
            .join('')}</div>`,
      )
      .join('') +
    `<div class="docs-group"><div class="docs-group-label">repo/</div>${REPO_REFERENCES.map(([path, label]) => `<a href="${REPO_URL}/blob/main/${path}"><span class="docs-marker" aria-hidden="true"> </span><span>${label} ↗</span></a>`).join('')}</div>`
  )
}

export function renderPager(page: DocsPage, pages: readonly DocsPage[] = DOCS_PAGES): string {
  const index = pages.findIndex((entry) => entry.path === page.path)
  return `<nav class="docs-pager" aria-label="Adjacent pages">${([-1, 1] as const)
    .map((offset) => {
      const entry = index < 0 ? undefined : pages[index + offset]
      return entry
        ? `<a class="${offset === 1 ? 'docs-next' : ''}" href="${escapeHtml(entry.path)}"><span>${offset === -1 ? '← previous' : 'next →'}</span><b>${escapeHtml(entry.label)}</b></a>`
        : '<span></span>'
    })
    .join('')}</nav>`
}

export interface DocsHeading {
  id: string
  label: string
}
function headingText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
      if (entity.startsWith('#'))
        return String.fromCodePoint(
          entity[1]?.toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1)),
        )
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[
          entity.toLowerCase()
        ] ?? _
      )
    })
}
export function prepareHeadings(content: string): { html: string; headings: DocsHeading[] } {
  const used = new Set([...content.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!))
  const headings: DocsHeading[] = []
  const html = content.replace(
    /<h2([^>]*)>([\s\S]*?)<\/h2>/g,
    (_, attrs: string, inner: string) => {
      const label = headingText(inner)
      let id = /\bid="([^"]+)"/.exec(attrs)?.[1]
      if (!id) {
        const base =
          label
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-|-$/g, '') || 'section'
        id = base
        let suffix = 2
        while (used.has(id)) id = `${base}-${suffix++}`
        used.add(id)
        attrs += ` id="${escapeHtml(id)}"`
      }
      headings.push({ id, label })
      return `<h2${attrs}>${inner}</h2>`
    },
  )
  return { html, headings }
}
function renderToc(headings: DocsHeading[]): string {
  return `<ul class="docs-section-list">${headings.map(({ id, label }, index) => `<li><a data-section="${escapeHtml(id)}" href="#${escapeHtml(id)}"${index === 0 ? ' aria-current="location"' : ''}><span class="docs-marker" aria-hidden="true">${index === 0 ? '&gt;' : ' '}</span><span>${escapeHtml(label)}</span></a></li>`).join('')}</ul>`
}
