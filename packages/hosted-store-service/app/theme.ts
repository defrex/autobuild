export const THEME_KEY = 'autobuild.theme'
export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]
export function themePreference(value: unknown): Theme {
  return value === 'light' || value === 'dark' ? value : 'system'
}
export function applyTheme(theme: Theme, root = document.documentElement) {
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}
/** Synchronous head script: CSS handles the live system preference. */
export const THEME_BOOTSTRAP = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);else document.documentElement.removeAttribute('data-theme')}catch(e){}`
