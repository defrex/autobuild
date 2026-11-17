declare module '*.css'

interface Window {
  /** Installed by the layout's head script; explicit error boundaries report through it. */
  __autobuildReportBrowserError?: (error: unknown) => void
}
