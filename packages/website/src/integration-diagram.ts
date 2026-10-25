import { COLOR, esc } from './svg'

const DESCRIPTION =
  'ab ticket tree output: the node ticket AUT-837, Website for 1.0, under main, with the eleven finished work tickets that built this website beneath it. Each merged on the node’s branch; main receives the node once, as one pull request.'

/** The node that built this website, as `ab ticket tree` prints it. */
const NODE = { id: 'AUT-837', title: 'Website for 1.0', branch: 'ab-node/website-integration' }
const CHILDREN = [
  ['AUT-838', 'Verify animated figures and docs pages on the website'],
  ['AUT-839', 'Animate the pipeline figure on the website'],
  ['AUT-840', 'Animate the dispatcher and intake figures on the website'],
  ['AUT-841', 'Show the integration tree on the landing page'],
  ['AUT-842', 'Add a documentation section to the website'],
  ['AUT-843', 'Document builds, dispatch, integration and tickets on the website'],
  ['AUT-844', 'Document operating, seams and configuration on the website'],
  ['AUT-863', 'Keep the website capture unit test within its timeout'],
  ['AUT-874', 'Give the website one shared header across the landing page and docs'],
  ['AUT-875', 'Lay out the docs pages like a standard documentation site'],
  ['AUT-876', 'Add Copy as Markdown to every docs page'],
] as const

const span = (color: string, text: string): string =>
  `<span style="color: ${color}">${esc(text)}</span>`

export function integrationDiagram(): string {
  const lines = [
    `${span(COLOR.slack, '$ ')}<b>bun ab ticket tree</b>`,
    'main',
    `  <b>${NODE.id}</b> <b style="color: ${COLOR.live}">[node]</b> <b>${esc(NODE.title)}</b>`,
    ...CHILDREN.map(
      ([id, title]) =>
        `    ${id} ${span(COLOR.slack, '[work]')} ${span(COLOR.ok, '(Done)')} ${esc(title)}`,
    ),
    '',
    span(
      COLOR.slack,
      `${CHILDREN.length} tickets merged on ${NODE.branch} · main receives one pull request`,
    ),
  ]
  return `<div data-capture-figure="integration-tree"><div class="scroll" tabindex="0" role="region" aria-label="${esc(DESCRIPTION)}"><pre class="frame">${lines.join('\n')}</pre></div></div>`
}
