/**
 * The terminal's ANSI colour for each shared tone. The dashboard renderer and
 * the plain `ab builds` / `ab build status` text paint a tone through the same
 * table, so a status word has one colour on every terminal surface.
 *
 * Pure: no IO and no `process`. Whether to paint is the caller's decision.
 */
import type { DashboardTone } from './vocabulary'

export const ESC = '\x1b['
export const RESET = `${ESC}0m`

export const CODES = {
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  cyan: 36,
  bold: 1,
} as const
export type ColorName = keyof typeof CODES

/** The terminal's colour for each shared tone. */
export const TONE_COLOR: Record<DashboardTone, ColorName> = {
  ok: 'green',
  live: 'cyan',
  held: 'yellow',
  alert: 'red',
  pending: 'dim',
}

export function paint(text: string, color: ColorName, on: boolean): string {
  return on ? `${ESC}${CODES[color]}m${text}${RESET}` : text
}

export function paintTone(text: string, tone: DashboardTone, on: boolean): string {
  return paint(text, TONE_COLOR[tone], on)
}
