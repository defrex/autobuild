/** Diagram vocabulary: connector styles are defined once, here. */
export const COLOR = {
  ground: '#000000',
  well: '#141414',
  rule: '#292929',
  dimLine: '#3a3a3a',
  ink: '#e6e6e6',
  slack: '#888888',
  title: '#d7c84f',
  live: '#55b8b8',
  ok: '#65b868',
  alert: '#d96868',
} as const

export const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export type ConnectorKind =
  | 'flow' // slack solid
  | 'write' // live solid: agents writing through ab, revise loops
  | 'event' // slack dashed: runner-written events
  | 'fail' // alert dashed: failure loops
  | 'escalate' // title solid: escalation loop

const KIND: Record<ConnectorKind, { stroke: string; dashed: boolean }> = {
  flow: { stroke: COLOR.slack, dashed: false },
  write: { stroke: COLOR.live, dashed: false },
  event: { stroke: COLOR.slack, dashed: true },
  fail: { stroke: COLOR.alert, dashed: true },
  escalate: { stroke: COLOR.title, dashed: false },
}

export interface Connector {
  kind: ConnectorKind
  left: number
  top: number
  width: number
  height: number
  path: string
  arrow?: boolean
}

let markerCount = 0

export function connector(c: Connector): string {
  const { stroke, dashed } = KIND[c.kind]
  const id = `arrow-${markerCount++}`
  const marker = c.arrow
    ? `<defs><marker id="${id}" orient="auto" markerWidth="5" markerHeight="5" refX="3.2" refY="2" overflow="visible"><path d="M0 0 L4 2 L0 4 Z" fill="${stroke}" stroke="none"/></marker></defs>`
    : ''
  const markerEnd = c.arrow ? ` marker-end="url(#${id})"` : ''
  const dash = dashed ? '; stroke-dasharray: 6 4' : ''
  return `<svg width="${c.width}" height="${c.height}" viewBox="0 0 ${c.width} ${c.height}" preserveAspectRatio="none" aria-hidden="true" style="position: absolute; left: ${c.left}px; top: ${c.top}px; width: ${c.width}px; height: ${c.height}px; overflow: visible; fill: none; stroke: ${stroke}; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round${dash}">${marker}<path d="${c.path}"${markerEnd}/></svg>`
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface NodeOptions extends Box {
  /** Inner HTML of the label; already escaped. */
  html: string
  color?: string
  border?: string
  padding?: string
}

export function node(n: NodeOptions): string {
  const border = n.border ? `; border: 2px solid ${n.border}` : ''
  return `<div style="position: absolute; left: ${n.left}px; top: ${n.top}px; width: ${n.width}px; height: ${n.height}px; box-sizing: border-box; padding: ${n.padding ?? '8px 12px'}; display: flex; align-items: center; justify-content: center; text-align: center; background: ${COLOR.well}${border}; color: ${n.color ?? COLOR.ink}"><span>${n.html}</span></div>`
}

export const label = (text: string, color: string = COLOR.ink): string =>
  `<b style="color: ${color}">${esc(text)}</b>`

export function plainNode(
  left: number,
  top: number,
  width: number,
  height: number,
  text: string,
  color: string = COLOR.ink,
): string {
  return node({ left, top, width, height, html: label(text, color), color })
}

export interface CaptionOptions {
  left: number
  top: number
  width: number
  text: string
  color?: string
  bold?: boolean
  align?: 'left' | 'right'
}

export function caption(c: CaptionOptions): string {
  return `<div style="position: absolute; left: ${c.left}px; top: ${c.top}px; width: ${c.width}px; font-size: 14px; line-height: 20px; text-align: ${c.align ?? 'left'}; color: ${c.color ?? COLOR.slack}; font-weight: ${c.bold ? 700 : 400}; white-space: nowrap">${esc(c.text)}</div>`
}

/** One progress cell: done, current, or pending. */
export function cell(left: number, top: number, state: 'done' | 'live' | 'pending'): string {
  const fill =
    state === 'pending'
      ? `border: 2px solid ${COLOR.dimLine}`
      : `background: ${state === 'done' ? COLOR.ok : COLOR.live}`
  return `<div style="position: absolute; left: ${left}px; top: ${top}px; width: 24px; height: 24px; box-sizing: border-box; ${fill}"></div>`
}

/** A fixed-size diagram that scrolls sideways inside its own container below 720px. */
export function diagram(width: number, height: number, description: string, body: string): string {
  return `<div class="scroll" tabindex="0" role="region" aria-label="${esc(description)}"><div role="img" aria-label="${esc(description)}" style="position: relative; width: ${width}px; height: ${height}px">${body}</div></div>`
}
