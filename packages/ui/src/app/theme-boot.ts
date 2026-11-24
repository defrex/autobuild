/* A classic script the page loads before first paint: stamp the stored theme
   so the first frame is already on the right ground. Kept import-free; the
   key matches THEME_STORAGE_KEY in packages/core/src/web/protocol.ts. */
try {
  const theme = localStorage.getItem('ab-theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch {
  // Storage can be unavailable; the system theme applies.
}
