/**
 * The `ab web` wire protocol: what the server pushes and what the page reads.
 * Types, constants and one error class, so the browser client imports it as
 * types without pulling server code into its bundle.
 */
import type { DashboardRepositoryHeader } from '../cli/dashboard/header'
import type {
  AttentionItem,
  DashboardOverview,
  DashboardRowText,
  DispatcherModeText,
  FinishedRowText,
  HarvestRowText,
} from '../cli/dashboard/row-text'

/**
 * Row and overview terms are aliases of the shared dashboard projection, never
 * restatements, so the web cannot drift into its own wording. Step timing
 * travels raw; the page formats elapsed time with `cli/dashboard/vocabulary`.
 */
export type WebBuildRow = DashboardRowText
export type WebHarvestRow = HarvestRowText
export type WebFinishedRow = FinishedRowText
export type WebAttentionItem = AttentionItem
export type WebDispatcherMode = DispatcherModeText
export type WebOverview = DashboardOverview

/**
 * One model frame, pushed whole over the `/events` stream as JSON. Later
 * views add optional members; every member must survive a JSON round trip
 * unchanged (no `undefined` values, dates, maps or sets), because the server
 * compares serialized frames to decide whether to push.
 */
export interface WebFrame {
  /** The repository-scope dashboard header, the same terms the terminal shows. */
  repository?: DashboardRepositoryHeader
  /** The overview page: dispatcher mode, header terms, attention list, active,
   * queued and finished rows, all from the shared projection the terminal
   * renders. */
  overview?: WebOverview
  /** A one-line notice standing in for content that cannot be shown yet. */
  notice?: string
}

/**
 * Produces frames for the shared refresh loop. `live` asks for the fast
 * cadence. `admitted` reports whether anyone still wants the frame: a source
 * checks it before each further store read and, once it is false, stops with
 * `WebReadFencedError` instead of reading on for nobody.
 */
export interface WebFrameSource {
  read(admitted?: () => boolean): Promise<{ frame: WebFrame; live: boolean } | undefined>
}

/** A frame read abandoned because its last subscriber left; not a failure. */
export class WebReadFencedError extends Error {
  constructor() {
    super('ab web read abandoned: no subscriber')
    this.name = 'WebReadFencedError'
  }
}

/** Server-sent event names on `/events`. */
export const WEB_EVENTS = { model: 'model' } as const

/** `<meta name>` carrying the repository label into the page. */
export const REPOSITORY_META = 'ab-repository'

/**
 * `<meta name>` carrying the hub's current frame, serialized, into the page.
 * It is a layout hint: the page renders it masked as its loading skeleton so
 * the skeleton has the loaded page's geometry. It is never shown as live data;
 * the facts come from the `/events` stream.
 */
export const FRAME_META = 'ab-frame'

/**
 * How long a page request waits for the hub's first frame when it holds none.
 * A safety bound for a hung first read, not an expected wait: the hub delivers
 * a frame, data or a failure notice, for every read that finishes.
 */
export const PAGE_FRAME_WAIT_MS = 10_000

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
