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
<p>Start with <a href="/docs/getting-started/">Getting started</a> for installation and a first ticket. These pages introduce the system for engineers evaluating it. Feature-area guides will be added separately; the repository holds the detailed references today.</p>
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
