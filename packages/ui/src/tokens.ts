/**
 * Autobuild ANSI tokens. This file is the source of truth: the CSS custom
 * properties in `generated/tokens.css` are generated from it by
 * `bun packages/ui/scripts/tokens.ts`, and a freshness test keeps them equal.
 */

export type Ground = 'light' | 'dark'

/** Ground and ink primitives. State inks carry meaning (the Color Is State rule). */
export const color = {
  light: {
    ground: '#fbfbfc',
    ink: '#1a1d24',
    slack: '#5f6571',
    rule: '#dfe2e8',
    well: '#f5f6f8',
    blue: '#2557e6',
    green: '#10862f',
    amber: '#b35c00',
    teal: '#007f8a',
    red: '#d32b33',
    redWash: '#fef2f1',
    select: '#c9d5f7',
  },
  dark: {
    ground: '#101219',
    ink: '#dcdfe5',
    slack: '#858b97',
    rule: '#262a35',
    well: '#181b24',
    blue: '#86a3f2',
    green: '#8fcf6e',
    amber: '#e8aa52',
    teal: '#52c3c3',
    red: '#f07777',
    redWash: '#2a1719',
    select: '#2c3a66',
  },
} as const satisfies Record<Ground, Record<string, string>>

export type ColorRole = keyof (typeof color)['light']

/**
 * Chart-only phase hues. They identify a family of pipeline work inside a
 * chart that also carries a legend and labels; they never signal state.
 * Validated as an adjacent-order categorical palette on both grounds
 * (dataviz validate_palette: CVD ΔE ≥ 11.5, normal-vision ΔE ≥ 16.4, ≥ 3:1).
 */
export const phaseHue = {
  light: { plan: '#6a4fd8', implement: '#c43d8c', verify: '#5a7f1a', land: '#2f7fb0' },
  dark: { plan: '#8f7bea', implement: '#d9689f', verify: '#7f9f36', land: '#4b93c8' },
} as const satisfies Record<Ground, Record<string, string>>

export type PhaseFamily = keyof (typeof phaseHue)['light']

/** How each timeline segment category is drawn. Waits reuse state inks
 * because they are states: pending is slack, held is amber, a human blocker
 * is red. Review rounds share their authoring family's hue, hatched. */
export const segmentStyle = {
  plan: { family: 'plan', fill: 'solid' },
  'plan-review': { family: 'plan', fill: 'hatch' },
  implement: { family: 'implement', fill: 'solid' },
  'code-review': { family: 'implement', fill: 'hatch' },
  verify: { family: 'verify', fill: 'solid' },
  finalize: { family: 'land', fill: 'solid' },
  reconcile: { family: 'land', fill: 'hatch' },
  queued: { state: 'slack', fill: 'hatch' },
  'ticket-wait': { state: 'amber', fill: 'hatch' },
  paused: { state: 'amber', fill: 'hatch' },
  'awaiting-merge': { state: 'amber', fill: 'outline' },
  escalated: { state: 'red', fill: 'hatch' },
} as const satisfies Record<
  string,
  { family: PhaseFamily; fill: 'solid' | 'hatch' } | { state: ColorRole; fill: 'hatch' | 'outline' }
>

export type SegmentCategory = keyof typeof segmentStyle

export const font = {
  sans: '"Atkinson Hyperlegible Next", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
} as const

export const type = {
  body: { size: '15px', wideSize: '16px', wideAt: '1280px', lineHeight: 1.5 },
  machine: { size: '0.93em' },
  detailHeading: { size: '1.05em' },
  pageHeading: { size: '1.6em', lineHeight: 1.2 },
  weight: { regular: 400, semibold: 600, bold: 700 },
} as const

export const space = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '40px',
  xxl: '64px',
} as const

export const layout = {
  frame: '1180px',
  measure: '72ch',
  identityColumn: '6.5rem',
  gutter: '16px',
  narrowAt: '720px',
} as const

export const stroke = { rule: '1px', control: '1.5px', tabBar: '2px', focus: '2px' } as const

export const backdropOpacity = 0.72
