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
 * The Chart Hue rule: charts never use the state inks. Hue means work, in
 * four families; neutral means waiting, in two weights. Texture separates
 * the categories inside a family, so identity never rests on hue alone.
 * The work hues validate as an adjacent-order categorical palette on both
 * grounds (dataviz validate_palette: CVD ΔE ≥ 11.5, normal-vision ΔE ≥ 16.4,
 * every mark ≥ 3:1 on its ground).
 */
export const chartHue = {
  light: {
    plan: '#6a4fd8',
    implement: '#c43d8c',
    verify: '#5a7f1a',
    land: '#2f7fb0',
    wait: '#8a8f99',
    waitStrong: '#3a3d45',
  },
  dark: {
    plan: '#8f7bea',
    implement: '#d9689f',
    verify: '#7f9f36',
    land: '#4b93c8',
    wait: '#6b717d',
    waitStrong: '#c4c8d0',
  },
} as const satisfies Record<Ground, Record<string, string>>

export type ChartFamily = keyof (typeof chartHue)['light']

export type SegmentFill = 'solid' | 'hatch' | 'cross' | 'outline'

/** How each timeline segment category is drawn. Review rounds share their
 * authoring family's hue, hatched. Waits are neutral: queued hatched, held
 * cross-hatched, awaiting merge outlined, and an escalation, the one wait a
 * human ends, in the strong neutral. */
export const segmentStyle = {
  plan: { family: 'plan', fill: 'solid' },
  'plan-review': { family: 'plan', fill: 'hatch' },
  implement: { family: 'implement', fill: 'solid' },
  'code-review': { family: 'implement', fill: 'hatch' },
  verify: { family: 'verify', fill: 'solid' },
  finalize: { family: 'land', fill: 'solid' },
  reconcile: { family: 'land', fill: 'hatch' },
  queued: { family: 'wait', fill: 'hatch' },
  'ticket-wait': { family: 'wait', fill: 'cross' },
  paused: { family: 'wait', fill: 'cross' },
  'awaiting-merge': { family: 'wait', fill: 'outline' },
  escalated: { family: 'waitStrong', fill: 'hatch' },
} as const satisfies Record<string, { family: ChartFamily; fill: SegmentFill }>

/** The Deliberate Transition rule's timings. Exits run faster than entries;
 * reduced motion keeps the fades and drops the travel. */
export const motion = {
  feedback: '120ms',
  state: '200ms',
  layout: '320ms',
  exitScale: 0.7,
  travel: '4px',
  ease: 'cubic-bezier(0.16, 1, 0.3, 1)',
} as const

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
