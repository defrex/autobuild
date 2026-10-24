'use client'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { applyTheme, THEME_KEY, type Theme, themePreference } from './theme'
const ThemeContext = createContext<{ theme: Theme; choose: (theme: Theme) => void }>({
  theme: 'system',
  choose: () => {},
})
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('system')
  useEffect(() => {
    try {
      setTheme(themePreference(localStorage.getItem(THEME_KEY)))
    } catch {}
    const update = (event: StorageEvent) => {
      if (event.key !== THEME_KEY && event.key !== null) return
      const next = themePreference(event.newValue)
      setTheme(next)
      applyTheme(next)
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [])
  const choose = (next: Theme) => {
    setTheme(next)
    applyTheme(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {}
  }
  return <ThemeContext.Provider value={{ theme, choose }}>{children}</ThemeContext.Provider>
}
export const useTheme = () => useContext(ThemeContext)
