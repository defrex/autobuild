import { heroFrame } from './frame'
import { dispatcherDiagram, dispatcherLegend, intakeDiagram, pipelineDiagram } from './diagrams'
import { INSTALL_COMMAND, REPO_URL } from './constants'
import { seamSelector } from './seams-view'

const FONT_URL =
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&amp;display=swap'

function intro(eyebrow: string, title: string, lead?: string, id?: string): string {
  const leadHtml = lead ? `<p class="lead">${lead}</p>` : ''
  return `<div class="intro"${id ? ` id="${id}"` : ''}><div class="titles"><div class="eyebrow">${eyebrow}</div><h2 class="headline">${title}</h2></div>${leadHtml}</div>`
}

const prompt = `<span class="dim">$ </span>`

function cmd(promptHtml: string, command: string, note: string, color?: string): string {
  const style = color ? ` style="color: ${color}"` : ''
  return `<div class="cmd"><span>${promptHtml}<b${style}>${command}</b></span><span class="dim">${note}</span></div>`
}

const hero = (frame: string): string =>
  `<section class="section"><div class="hero"><h1 class="display">Tickets in,<br>Product out.</h1><p class="lead">Autobuild runs coding agents through a fixed pipeline that plans, implements, reviews, and verifies every ticket before it merges.</p><div class="actions"><div class="install"><span>${prompt}<code>${INSTALL_COMMAND}</code></span><button class="word" type="button" data-copy>copy</button></div><a class="btn" href="${REPO_URL}">View on GitHub</a></div></div>${heroFrame(frame)}</section>`

const pipeline = `<section class="section">${intro('autobuild · how it works', 'Every ticket runs the pipeline', 'Each ticket moves through deterministic phases inside its own build-runner. Every phase is a fresh agent session, with artifacts knitting them together.', 'how')}${pipelineDiagram()}</section>`

const dispatcher = `<section class="section">${intro('autobuild · the map', 'A dispatcher spawns builds', 'The dispatcher claims ready tickets and starts a build-runner for each. Runners are isolated, all state is logged.')}${dispatcherDiagram()}${dispatcherLegend()}</section>`

const seams = `<section class="section">${intro('autobuild · seams', 'All local, all remote, or anywhere between', 'Every seam is an adapter you can customize for your project. The build pipeline stays the same.')}${seamSelector()}</section>`

const throughput = `<section class="section">${intro('autobuild · throughput', 'Built for throughput, not latency', 'One build may take longer than a chat with an agent. The trade is far more changes landing every day, and with much greater reliability.', 'why')}<div class="two"><div class="point"><b>File it and walk away</b><p>Nothing in the pipeline waits on you. You don't approve tool calls, paste errors back, or watch a terminal.</p></div><div class="point"><b>As many builds as you can groom</b><p>Builds run side by side, each in its own workspace, up to the limit you set. Your attention stops being the ceiling.</p></div></div></section>`

const intake = `<section class="section">${intro('autobuild · intake', 'Let the queue fill itself', 'Once tickets are the interface, anything that can write a ticket can put work in front of you.')}${intakeDiagram()}</section>`

const start = `<section class="section">${intro('autobuild · get started', 'Start with one ticket')}<div class="terminal">${cmd(prompt, INSTALL_COMMAND, 'install the ab CLI')}${cmd(prompt, 'ab init', 'vendor the skills, write autobuild.toml')}${cmd(prompt, 'ab dispatch', 'start the dispatcher and the dashboard', '#65b868')}${cmd(`<span class="dim">&gt; </span>`, '/ab-spec add a retry budget', 'groom a ticket in your coding agent', '#55b8b8')}</div><div class="actions links"><a class="btn" href="${REPO_URL}">View on GitHub</a></div></section>`

export interface PageInput {
  /** The tracked `hero-frame.txt`: the dashboard's own ANSI lines. */
  heroFrame: string
}

export function renderPage({ heroFrame: frame }: PageInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autobuild</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="${FONT_URL}">
<link rel="stylesheet" href="site.css">
<script type="module" src="site.js" defer></script>
</head>
<body>
<header class="wrap"><div class="masthead"><b class="title">Autobuild</b><a class="dim" href="${REPO_URL}"><span class="hide-sm">github.com/defrex/autobuild</span><span class="show-sm">GitHub</span></a></div></header>
<main class="wrap"><div class="sections">${hero(frame)}${pipeline}${dispatcher}${seams}${throughput}${intake}${start}</div></main>
<footer class="wrap"><div class="foot"><span>Autobuild · Apache-2.0</span><a class="dim" href="${REPO_URL}">github.com/defrex/autobuild</a></div></footer>
</body>
</html>
`
}
