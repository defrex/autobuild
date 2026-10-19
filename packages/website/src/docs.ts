import { INSTALL_COMMAND, REPO_URL, SITE_URL } from './constants'
import { OG_HEIGHT, OG_IMAGE_ALT, OG_WIDTH } from './og'

export interface DocsPage {
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
<p>Start with <a href="/docs/getting-started/">Getting started</a> for installation and a first ticket. These pages introduce the system for engineers evaluating it. Read <a href="/docs/operating/">Operating</a> for day-to-day control, <a href="/docs/seams/">Seams</a> for infrastructure choices, and <a href="/docs/configuration/">Configuration</a> for the repository settings. Each guide links to detailed repository references.</p>
<p>The ${reference('docs/configuration.md', 'configuration reference')} describes what you configure. The ${reference('docs/spec-standard.md', 'spec standard')} defines a buildable ticket.</p>`,
  },
  {
    path: '/docs/getting-started/',
    file: 'docs/getting-started/index.html',
    label: 'Getting started',
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
    path: '/docs/operating/',
    file: 'docs/operating/index.html',
    label: 'Operating',
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
  const nav = DOCS_PAGES.map(
    (entry) =>
      `<li><a href="${escapeHtml(entry.path)}"${entry.path === page.path ? ' aria-current="page"' : ''}>${escapeHtml(entry.label)}</a></li>`,
  ).join('')
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
<body class="docs">
<a class="skip-link" href="#content">Skip to content</a>
<header class="docs-wrap"><div class="masthead"><a class="title" href="/">Autobuild</a><a href="${REPO_URL}">GitHub</a></div><nav aria-label="Documentation"><ul>${nav}</ul></nav></header>
<main id="content" tabindex="-1" class="docs-wrap"><article><h1 class="headline">${escapeHtml(page.title)}</h1>${page.content}</article></main>
<footer class="docs-wrap"><div class="foot"><span>Autobuild · Apache-2.0</span><a href="/">Home</a></div></footer>
</body>
</html>
`
}
