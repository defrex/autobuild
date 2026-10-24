;(() => {
  try {
    const theme = localStorage.getItem('proa-theme')
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  } catch {
    /* Storage can be disabled; System remains the default. */
  }
})()
