import { replayControl } from './motion-control'
import { caption, COLOR, connector, diagram, node, phoneDiagram } from './svg'

const DESCRIPTION =
  'Integration tree: main is the root. Node ticket NODE-1 owns ab-node/release. Build A and build B target the node. A lands; B restacks onto the new node head and lands. The complete node verifies, then lands into main with consent.'
const tag = (html: string, keys: string): string =>
  html.replace(/<(div|svg) /, `<$1 data-integration-beats="${keys}" `)

function drawing(phone: boolean): string {
  const center = phone ? 179 : 300
  const box = (top: number, width: number, html: string, beats: string): string =>
    tag(node({ left: center - width / 2, top, width, height: 64, html, color: COLOR.ok }), beats)
  const edge = (
    left: number,
    top: number,
    width: number,
    height: number,
    path: string,
    beats: string,
  ): string => tag(connector({ left, top, width, height, path, kind: 'flow', arrow: true }), beats)
  const childY = 304
  const left = phone ? 0 : 80
  const right = phone ? 198 : 360
  let body = box(0, 160, '<b>[x] main</b><br>root · landed', 'consent')
  body += edge(center, 72, 1, 64, 'M0 64 V0', 'consent')
  body += caption({ left: center + 16, top: 90, width: 160, text: 'land ↑', color: COLOR.slack })
  body += box(
    144,
    phone ? 254 : 280,
    '<b>[x] node · NODE-1</b><br>ab-node/release',
    'restack complete verify',
  )
  body += caption({
    left: center - 150,
    top: 216,
    width: 300,
    text: 'new head after A lands',
    align: 'center',
  })
  body += edge(
    left + 80,
    244,
    center - left - 80,
    52,
    `M0 52 V16 H${center - left - 80} V0`,
    'a-land',
  )
  body += edge(
    center,
    244,
    right + 80 - center,
    52,
    `M${right + 80 - center} 52 V16 H0 V0`,
    'restack b-land',
  )
  body += caption({ left, top: 378, width: 160, text: 'land ↑', align: 'center' })
  body += caption({ left: right, top: 378, width: 160, text: 'restack → land ↑', align: 'center' })
  for (const [x, name, beats] of [
    [left, 'A', 'a-land'],
    [right, 'B', 'restack b-land'],
  ] as const) {
    body += tag(
      node({
        left: x,
        top: childY,
        width: 160,
        height: 64,
        html: `<b>[x] build ${name}</b><br>target: NODE-1`,
        color: COLOR.ok,
      }),
      beats,
    )
  }
  const steps = [
    ['a-land', '1 build A lands'],
    ['restack b-land', '2 build B restacks → lands'],
    ['complete verify', '3 node complete → verify:*'],
    ['consent', '4 consent → land into main'],
  ]
  for (const [i, [beats, text]] of steps.entries()) {
    body += tag(
      caption({
        left: phone ? 0 : 688,
        top: (phone ? 416 : 72) + i * 56,
        width: phone ? 358 : 400,
        text: text!,
        color: COLOR.ink,
        bold: true,
      }),
      beats!,
    )
  }
  return body
}

export function integrationDiagram(): string {
  return (
    '<div data-capture-figure="integration-tree" data-capture-animated>' +
    diagram(1120, 400, DESCRIPTION, drawing(false)) +
    phoneDiagram(640, DESCRIPTION, drawing(true)) +
    replayControl('integration tree') +
    '</div>'
  )
}
