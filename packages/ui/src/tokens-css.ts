import {
  backdropOpacity,
  color,
  font,
  type Ground,
  layout,
  phaseHue,
  space,
  stroke,
  type,
} from './tokens'

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

function groundVars(ground: Ground): string[] {
  return [
    `color-scheme: ${ground};`,
    ...Object.entries(color[ground]).map(([k, v]) => `--${kebab(k)}: ${v};`),
    ...Object.entries(phaseHue[ground]).map(([k, v]) => `--phase-${k}: ${v};`),
  ]
}

const block = (selector: string, lines: string[], indent = '') =>
  `${indent}${selector} {\n${lines.map((l) => `${indent}  ${l}`).join('\n')}\n${indent}}`

/** The generated stylesheet: shared scales on :root, the light ground by
 * default, dark from the OS unless a theme is stamped, and both stamps. */
export function tokensCss(): string {
  const shared = [
    `--sans: ${font.sans};`,
    `--mono: ${font.mono};`,
    `--fs: ${type.body.size};`,
    `--lh: ${type.body.lineHeight};`,
    `--fs-machine: ${type.machine.size};`,
    `--fs-detail-heading: ${type.detailHeading.size};`,
    `--fs-page-heading: ${type.pageHeading.size};`,
    ...Object.entries(space).map(([k, v]) => `--space-${k}: ${v};`),
    `--frame: ${layout.frame};`,
    `--measure: ${layout.measure};`,
    `--idcol: ${layout.identityColumn};`,
    `--gutter: ${layout.gutter};`,
    `--stroke-rule: ${stroke.rule};`,
    `--stroke-control: ${stroke.control};`,
    `--stroke-tab: ${stroke.tabBar};`,
    `--stroke-focus: ${stroke.focus};`,
    `--backdrop-opacity: ${backdropOpacity};`,
  ]
  return [
    '/* Generated from packages/ui/src/tokens.ts. Do not edit. */',
    block(':root', [...shared, ...groundVars('light')]),
    `@media (min-width: ${type.body.wideAt}) {\n  :root {\n    --fs: ${type.body.wideSize};\n  }\n}`,
    `@media (prefers-color-scheme: dark) {\n${block(':root:where(:not([data-theme="light"]))', groundVars('dark'), '  ')}\n}`,
    block(':root[data-theme="dark"]', groundVars('dark')),
    block(':root[data-theme="light"]', groundVars('light')),
    '/* A region pinned to one ground, for side-by-side review. */',
    block('[data-ground="light"]', groundVars('light')),
    block('[data-ground="dark"]', groundVars('dark')),
  ]
    .join('\n\n')
    .concat('\n')
}
