import { replayControl } from './motion-control'
import {
  type Connector,
  type ConnectorKind,
  COLOR,
  caption,
  cell,
  connector,
  diagram,
  node,
  phoneDiagram,
  plainNode,
  rect,
} from './svg'

function c(
  kind: ConnectorKind,
  left: number,
  top: number,
  width: number,
  height: number,
  path: string,
  arrow = false,
): Connector {
  return { kind, left, top, width, height, path, arrow }
}

const PIPELINE_DESCRIPTION =
  'Inside one build-runner: spec feeds plan, which loops with plan-review, then implement, which loops with code-review, then verify:*, finalize, and merged. If verify:* fails, the flow returns to implement.'

const DISPATCHER_DESCRIPTION =
  'The dispatcher takes ready tickets and starts one build-runner per ticket. Each runner shows its progress cells, writes through the ab CLI to the build store, and sends phase events to the build store.'

const INTAKE_DESCRIPTION =
  'Customer support, meetings, telemetry and errors, and build observations all feed the PM agent. The PM agent sends tickets to the autobuild dispatcher. Escalations return from the dispatcher to the PM agent, which answers them itself. The PM agent and you are linked both ways, for only the real product calls.'

// Several desktop segments form one semantic edge; phone routing uses the same keys.
const desktopEdges = [
  'plan',
  'plan',
  'plan',
  'implement',
  'plan-review',
  'plan-return',
  'code-review',
  'code-return',
  'verify:*',
  'verify:*',
  'verify:*',
  'finalize',
  'merged',
  'failure',
  'failure',
  'failure',
]
const phoneEdges = [
  'plan',
  'implement',
  'finalize',
  'merged',
  'verify:*',
  'plan-review',
  'plan-return',
  'code-review',
  'code-return',
  'failure',
]

function pipelineEdge(edge: Connector, key: string): string {
  return connector(edge).replace('<svg ', `<svg data-motion-edge="${key}" `)
}

function pipelineNode(...args: Parameters<typeof plainNode>): string {
  return plainNode(...args)
    .replace(/<b style="color: [^"]+">/, '<b>')
    .replace('<div ', `<div data-motion-node="${args[4]}" `)
}

export function pipelineDiagram(): string {
  const connectors = [
    c('flow', 136, 204, 24, 8, 'M 0 4 L 24 4'),
    c('flow', 156, 124, 8, 84, 'M 4 84 L 4 0'),
    c('flow', 160, 120, 22, 8, 'M 0 4 L 22 4', true),
    c('flow', 320, 120, 46, 8, 'M 0 4 L 46 4', true),
    c('write', 225, 152, 8, 110, 'M 4 0 L 4 110', true),
    c('write', 271, 154, 8, 110, 'M 4 110 L 4 0', true),
    c('write', 409, 152, 8, 110, 'M 4 0 L 4 110', true),
    c('write', 455, 154, 8, 110, 'M 4 110 L 4 0', true),
    c('flow', 504, 120, 36, 8, 'M 0 4 L 36 4'),
    c('flow', 536, 124, 8, 84, 'M 4 0 L 4 84'),
    c('flow', 540, 204, 34, 8, 'M 0 4 L 34 4', true),
    c('flow', 712, 204, 46, 8, 'M 0 4 L 46 4', true),
    c('flow', 896, 204, 46, 8, 'M 0 4 L 46 4', true),
    c('fail', 640, 48, 8, 132, 'M 4 132 L 4 0'),
    c('fail', 436, 44, 208, 8, 'M 208 4 L 0 4'),
    c('fail', 432, 48, 8, 46, 'M 4 0 L 4 46', true),
  ]
  const nodes = [
    pipelineNode(0, 180, 136, 56, 'spec'),
    pipelineNode(184, 96, 136, 56, 'plan'),
    pipelineNode(184, 264, 136, 56, 'plan-review'),
    pipelineNode(368, 96, 136, 56, 'implement'),
    pipelineNode(368, 264, 136, 56, 'code-review'),
    pipelineNode(576, 180, 136, 56, 'verify:*'),
    pipelineNode(760, 180, 136, 56, 'finalize'),
    pipelineNode(944, 180, 136, 56, 'merged', COLOR.ok),
  ]
  const captions = [
    caption({ left: 287, top: 200, width: 56, text: 'revise', color: COLOR.live }),
    caption({ left: 471, top: 200, width: 56, text: 'revise', color: COLOR.live }),
    caption({
      left: 452,
      top: 16,
      width: 300,
      text: 'verify fails → back to implement',
      color: COLOR.alert,
      bold: true,
    }),
  ]
  return (
    '<div data-capture-figure="pipeline" data-capture-animated>' +
    diagram(
      1120,
      340,
      PIPELINE_DESCRIPTION,
      [
        ...connectors.map((edge, index) => pipelineEdge(edge, desktopEdges[index]!)),
        ...nodes,
        ...captions,
      ].join(''),
    ) +
    pipelinePhone() +
    replayControl('pipeline') +
    '</div>'
  )
}

function pipelinePhone(): string {
  const spine = [56, 144, 376, 464].map((top) => c('flow', 90, top, 8, 32, 'M 4 0 L 4 30', true))
  const connectors = [
    ...spine,
    c('flow', 90, 232, 8, 88, 'M 4 0 L 4 86', true),
    c('write', 164, 102, 54, 8, 'M 0 4 L 52 4', true),
    c('write', 164, 122, 54, 8, 'M 54 4 L 2 4', true),
    c('write', 164, 190, 54, 8, 'M 0 4 L 52 4', true),
    c('write', 164, 210, 54, 8, 'M 54 4 L 2 4', true),
    c('fail', 4, 200, 20, 152, 'M 20 148 L 4 148 L 4 4 L 18 4', true),
  ]
  const nodes = [
    pipelineNode(24, 0, 140, 56, 'spec'),
    pipelineNode(24, 88, 140, 56, 'plan'),
    pipelineNode(218, 88, 140, 56, 'plan-review'),
    pipelineNode(24, 176, 140, 56, 'implement'),
    pipelineNode(218, 176, 140, 56, 'code-review'),
    pipelineNode(24, 320, 140, 56, 'verify:*'),
    pipelineNode(24, 408, 140, 56, 'finalize'),
    pipelineNode(24, 496, 140, 56, 'merged', COLOR.ok),
  ]
  const captions = [
    caption({ left: 164, top: 146, width: 54, text: 'revise', color: COLOR.live, align: 'center' }),
    caption({ left: 164, top: 234, width: 54, text: 'revise', color: COLOR.live, align: 'center' }),
    caption({
      left: 106,
      top: 264,
      width: 252,
      text: 'verify fails →\nback to implement',
      color: COLOR.alert,
      bold: true,
    }),
  ]
  return phoneDiagram(
    552,
    PIPELINE_DESCRIPTION,
    [
      ...connectors.map((edge, index) => pipelineEdge(edge, phoneEdges[index]!)),
      ...nodes,
      ...captions,
    ].join(''),
  )
}

// Attach semantic identity to the existing primitive without changing its geometry.
function marked(html: string, key: string): string {
  return html.replace(/^<(div|svg)/, `<$1 data-sequence-key="${key}"`)
}

function routed(item: Connector, key: string): string {
  return marked(connector(item), key)
}

export function dispatcherDiagram(): string {
  const connectors = [
    c('flow', 144, 232, 46, 8, 'M 0 4 L 46 4', true),
    c('flow', 352, 232, 24, 8, 'M 0 4 L 24 4'),
    c('flow', 372, 96, 8, 280, 'M 4 0 L 4 280'),
    c('flow', 376, 92, 46, 8, 'M 0 4 L 46 4', true),
    c('flow', 376, 232, 46, 8, 'M 0 4 L 46 4', true),
    c('flow', 376, 372, 46, 8, 'M 0 4 L 46 4', true),
  ]
  const rows = [
    { top: 64, done: 2, current: 'plan-review' },
    { top: 204, done: 3, current: 'implement' },
    { top: 344, done: 5, current: 'verify:*' },
  ]
  const parts: string[] = connectors.map((item, i) =>
    routed(item, ['claim', 'route', 'route', 'start-0', 'start-1', 'start-2'][i]!),
  )
  const nodes: string[] = []
  for (const [index, row] of rows.entries()) {
    const y = row.top + 28
    parts.push(
      routed(c('flow', 600, y, 46, 8, 'M 0 4 L 46 4', true), `write-${index}`),
      routed(c('write', 864, y, 38, 8, 'M 0 4 L 38 4', true), `write-${index}`),
      routed(c('write', 968, y, 14, 8, 'M 0 4 L 14 4', true), `write-${index}`),
      routed(c('event', 508, row.top + 64, 8, 24, 'M 4 0 L 4 24'), `write-${index}`),
      routed(c('event', 512, row.top + 84, 470, 8, 'M 0 4 L 470 4', true), `write-${index}`),
    )
    nodes.push(
      marked(
        node({ left: 424, top: row.top, width: 176, height: 64, html: plainNode2('build-runner') }),
        `runner-${index}`,
      ),
    )
    for (let i = 0; i < 7; i++) {
      nodes.push(
        marked(
          cell(
            648 + i * 32,
            row.top + 20,
            i < row.done ? 'done' : i === row.done ? 'live' : 'pending',
          ),
          `runner-${index}`,
        ),
      )
    }
    nodes.push(
      caption({
        left: 648,
        top: row.top + 50,
        width: 216,
        text: `[>] ${row.current}`,
        color: COLOR.live,
        bold: true,
      }),
    )
    nodes.push(
      node({
        left: 904,
        top: row.top + 12,
        width: 64,
        height: 40,
        html: plainNode2('ab', COLOR.live),
        color: COLOR.live,
      }),
    )
  }
  const rest = [
    caption({ left: 0, top: 148, width: 144, text: 'ready tickets' }),
    marked(plainNode(0, 168, 144, 40, 'ticket'), 'ticket-0'),
    marked(plainNode(0, 216, 144, 40, 'ticket'), 'ticket-1'),
    marked(plainNode(0, 264, 144, 40, 'ticket'), 'ticket-2'),
    marked(plainNode(192, 200, 160, 72, 'dispatcher'), 'dispatcher'),
    caption({ left: 648, top: 32, width: 240, text: 'one agent session per step' }),
    marked(
      node({
        left: 984,
        top: 48,
        width: 136,
        height: 400,
        padding: '12px',
        html: `<b>build store</b><br><span style="color: ${COLOR.slack}">events<br>artifacts<br>streams</span>`,
      }),
      'store',
    ),
  ]
  return (
    '<div data-capture-figure="dispatcher" data-capture-animated>' +
    diagram(1120, 470, DISPATCHER_DESCRIPTION, [...parts, ...nodes, ...rest].join('')) +
    dispatcherPhone() +
    replayControl('dispatcher') +
    '</div>'
  )
}

function dispatcherPhone(): string {
  const joins = [51, 175, 299].map((left) => c('flow', left, 64, 8, 16, 'M 4 0 L 4 16'))
  const connectors = [
    ...joins,
    c('flow', 55, 76, 248, 8, 'M 0 4 L 248 4'),
    c('flow', 175, 80, 8, 24, 'M 4 0 L 4 22', true),
    c('flow', 175, 160, 8, 32, 'M 4 0 L 4 30', true),
    c('write', 232, 288, 38, 8, 'M 0 4 L 36 4', true),
    c('event', 52, 344, 8, 48, 'M 4 0 L 4 46', true),
    c('write', 298, 312, 8, 80, 'M 4 0 L 4 78', true),
  ]
  const cells = [0, 1, 2, 3, 4, 5, 6].map((i) =>
    cell(16 + i * 32, 280, i < 3 ? 'done' : i === 3 ? 'live' : 'pending'),
  )
  // The runner card paints first so the connectors that cross it stay visible.
  const backdrop = [
    marked(rect({ left: 16, top: 192, width: 326, height: 136 }, null, COLOR.dimLine), 'runner-2'),
    marked(rect({ left: 8, top: 200, width: 342, height: 136 }, null, COLOR.dimLine), 'runner-1'),
    marked(rect({ left: 0, top: 208, width: 358, height: 136 }, COLOR.well), 'runner-0'),
  ]
  const parts = [
    caption({ left: 0, top: 0, width: 200, text: 'ready tickets' }),
    marked(plainNode(0, 24, 110, 40, 'ticket'), 'ticket-0'),
    marked(plainNode(124, 24, 110, 40, 'ticket'), 'ticket-1'),
    marked(plainNode(248, 24, 110, 40, 'ticket'), 'ticket-2'),
    marked(plainNode(99, 104, 160, 56, 'dispatcher'), 'dispatcher'),
    caption({
      left: 16,
      top: 222,
      width: 160,
      text: 'build-runner',
      color: COLOR.ink,
      html: `<b style="color: ${COLOR.ink}; font-size: 16px; line-height: 24px">build-runner</b>`,
    }),
    caption({ left: 182, top: 224, width: 160, text: '× 3, one per ticket', align: 'right' }),
    caption({ left: 16, top: 254, width: 260, text: 'one agent session per step' }),
    ...cells,
    node({
      left: 270,
      top: 272,
      width: 64,
      height: 40,
      html: plainNode2('ab', COLOR.live),
      background: COLOR.ground,
    }),
    caption({
      left: 16,
      top: 310,
      width: 260,
      text: '[>] implement',
      color: COLOR.live,
      bold: true,
    }),
    marked(
      node({
        left: 0,
        top: 392,
        width: 358,
        height: 72,
        html: `<b>build store</b><br><span style="color: ${COLOR.slack}">events · artifacts · streams</span>`,
      }),
      'store',
    ),
  ]
  return phoneDiagram(
    464,
    DISPATCHER_DESCRIPTION,
    [
      ...backdrop,
      ...connectors.map((item, i) =>
        routed(
          item,
          [
            'ticket-0',
            'ticket-1',
            'ticket-2',
            'claim',
            'claim',
            'start',
            'write',
            'write',
            'write',
          ][i]!,
        ),
      ),
      ...parts,
    ].join(''),
  )
}

function plainNode2(text: string, color: string = COLOR.ink): string {
  return `<b style="color: ${color}">${text}</b>`
}

export function dispatcherLegend(): string {
  const arrowhead = (stroke: string, dashed: boolean): string =>
    `<svg width="40" height="8" viewBox="0 0 40 8" aria-hidden="true" style="overflow: visible"><path d="M 0 4 L 32 4" stroke="${stroke}" stroke-width="2"${dashed ? ' stroke-dasharray="6 4"' : ''} fill="none"/><path d="M 30 1 L 36 4 L 30 7 Z" fill="${stroke}"/></svg>`
  return `<div class="legend"><span>${arrowhead(COLOR.live, false)}agents write through the ab CLI</span><span>${arrowhead(COLOR.slack, true)}runners write phase events</span></div>`
}

export function intakeDiagram(): string {
  const connectors = [
    c('flow', 216, 24, 48, 8, 'M 0 4 L 48 4'),
    c('flow', 216, 96, 48, 8, 'M 0 4 L 48 4'),
    c('flow', 216, 168, 48, 8, 'M 0 4 L 48 4'),
    c('flow', 216, 240, 48, 8, 'M 0 4 L 48 4'),
    c('flow', 260, 28, 8, 216, 'M 4 0 L 4 216'),
    c('flow', 264, 132, 70, 8, 'M 0 4 L 70 4', true),
    c('write', 608, 120, 238, 8, 'M 0 4 L 238 4', true),
    c('escalate', 980, 156, 8, 84, 'M 4 0 L 4 84'),
    c('escalate', 544, 236, 440, 8, 'M 440 4 L 0 4'),
    c('escalate', 540, 194, 8, 46, 'M 4 46 L 4 0', true),
    c('event', 383, 192, 8, 118, 'M 4 0 L 4 118', true),
    c('event', 425, 194, 8, 118, 'M 4 118 L 4 0', true),
  ]
  const nodes = [
    marked(plainNode(0, 0, 216, 56, 'customer support'), 'source-0'),
    marked(plainNode(0, 72, 216, 56, 'meetings'), 'source-1'),
    marked(plainNode(0, 144, 216, 56, 'telemetry · errors'), 'source-2'),
    marked(plainNode(0, 216, 216, 56, 'build observations'), 'source-3'),
    node({
      left: 336,
      top: 80,
      width: 272,
      height: 112,
      border: COLOR.live,
      html: `<b style="font-size: 20px; line-height: 28px">PM agent</b><br><span style="color: ${COLOR.live}">persistent memory</span><br><span style="color: ${COLOR.slack}">any agent harness</span>`,
    }),
    node({
      left: 848,
      top: 92,
      width: 272,
      height: 64,
      html: `<b style="color: ${COLOR.ink}">autobuild</b><br><span style="color: ${COLOR.slack}; font-weight: 400">dispatcher</span>`,
    }),
    plainNode(344, 312, 128, 48, 'you'),
  ]
  const captions = [
    caption({ left: 624, top: 92, width: 80, text: 'tickets', color: COLOR.live, bold: true }),
    caption({
      left: 560,
      top: 252,
      width: 320,
      text: 'escalations, answered by the agent',
      color: COLOR.title,
      bold: true,
    }),
    caption({
      left: 88,
      top: 326,
      width: 240,
      text: 'only the real product calls',
      align: 'right',
    }),
  ]
  return (
    '<div data-capture-figure="intake" data-capture-animated>' +
    diagram(
      1120,
      368,
      INTAKE_DESCRIPTION,
      [
        ...connectors.map((item, i) =>
          routed(
            item,
            [
              'source-0',
              'source-1',
              'source-2',
              'source-3',
              'route',
              'route',
              'delivery',
              'escalation',
              'escalation',
              'escalation',
              'human',
              'human',
            ][i]!,
          ),
        ),
        ...nodes.map((html, i) =>
          i < 4
            ? html
            : marked(
                html,
                ['source-0', 'source-1', 'source-2', 'source-3', 'pm', 'queue', 'human'][i]!,
              ),
        ),
        ...captions,
      ].join(''),
    ) +
    intakePhone() +
    replayControl('intake') +
    '</div>'
  )
}

function intakePhone(): string {
  const connectors = [
    c('flow', 171, 28, 8, 8, 'M 0 4 L 8 4'),
    c('flow', 179, 28, 8, 8, 'M 8 4 L 0 4'),
    c('flow', 171, 108, 8, 8, 'M 0 4 L 8 4'),
    c('flow', 179, 108, 8, 8, 'M 8 4 L 0 4'),
    c('flow', 175, 32, 8, 144, 'M 4 0 L 4 142', true),
    c('event', 224, 220, 46, 8, 'M 0 4 L 44 4', true),
    c('event', 224, 236, 46, 8, 'M 46 4 L 2 4', true),
    c('write', 196, 288, 8, 80, 'M 4 0 L 4 78', true),
    c('escalate', 4, 228, 20, 176, 'M 20 172 L 4 172 L 4 4 L 18 4', true),
  ]
  const nodes = [
    marked(plainNode(0, 0, 171, 64, 'customer support'), 'source-0'),
    marked(plainNode(187, 0, 171, 64, 'meetings'), 'source-1'),
    marked(plainNode(0, 80, 171, 64, 'telemetry · errors'), 'source-2'),
    marked(plainNode(187, 80, 171, 64, 'build observations'), 'source-3'),
    node({
      left: 24,
      top: 176,
      width: 200,
      height: 112,
      border: COLOR.live,
      html: `<b style="font-size: 20px; line-height: 28px">PM agent</b><br><span style="color: ${COLOR.live}">persistent memory</span><br><span style="color: ${COLOR.slack}">any agent harness</span>`,
    }),
    plainNode(270, 208, 88, 48, 'you'),
    node({
      left: 24,
      top: 368,
      width: 200,
      height: 64,
      html: `<b style="color: ${COLOR.ink}">autobuild</b><br><span style="color: ${COLOR.slack}; font-weight: 400">dispatcher</span>`,
    }),
  ]
  const captions = [
    caption({
      left: 214,
      top: 264,
      width: 144,
      text: 'only the real\nproduct calls',
      align: 'right',
    }),
    caption({ left: 210, top: 318, width: 80, text: 'tickets', color: COLOR.live, bold: true }),
    caption({
      left: 40,
      top: 300,
      width: 140,
      text: 'escalations,\nanswered by\nthe agent',
      color: COLOR.title,
      bold: true,
    }),
  ]
  return phoneDiagram(
    432,
    INTAKE_DESCRIPTION,
    [
      ...connectors.map((item, i) =>
        routed(
          item,
          [
            'source-0',
            'source-1',
            'source-2',
            'source-3',
            'route',
            'human',
            'human',
            'delivery',
            'escalation',
          ][i]!,
        ),
      ),
      ...nodes.map((html, i) =>
        i < 4
          ? html
          : marked(
              html,
              ['source-0', 'source-1', 'source-2', 'source-3', 'pm', 'human', 'queue'][i]!,
            ),
      ),
      ...captions,
    ].join(''),
  )
}
