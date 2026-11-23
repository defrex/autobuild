/**
 * The `ab web` wire protocol: what the server pushes and what the page reads.
 * Types and constants only, so the browser client imports it as types without
 * pulling server code into its bundle.
 */
import type { DashboardRepositoryHeader } from '../cli/dashboard/header'

/**
 * One model frame, pushed whole over the `/events` stream as JSON. Later
 * views add optional members; every member must survive a JSON round trip
 * unchanged (no `undefined` values, dates, maps or sets), because the server
 * compares serialized frames to decide whether to push.
 */
export interface WebFrame {
  /** The repository-scope dashboard header, the same terms the terminal shows. */
  repository?: DashboardRepositoryHeader
  /** A one-line notice standing in for content that cannot be shown yet. */
  notice?: string
}

/** Produces frames for the shared refresh loop. `live` asks for the fast cadence. */
export interface WebFrameSource {
  read(): Promise<{ frame: WebFrame; live: boolean } | undefined>
}

/** Server-sent event names on `/events`. */
export const WEB_EVENTS = { model: 'model' } as const

/** `<meta name>` carrying the repository label into the page. */
export const REPOSITORY_META = 'ab-repository'

/** Browser storage key for the theme choice (`light` or `dark`; absent is system). */
export const THEME_STORAGE_KEY = 'ab-theme'

/** `manifest.json` beside the committed client assets. */
export interface WebAssetManifest {
  /** Every served file, with its content type. */
  files: { path: string; type: string }[]
  script: string
  stylesheet: string
  themeScript: string
  /** Font files the page preloads. */
  fonts: string[]
}
