/** Only the connection return route is accepted; never a supplied origin. */
export function connectionReturnPath(value: string | undefined): string {
  if (!value) return '/'
  try {
    const parsed = new URL(value, 'https://return.invalid')
    if (
      !value.startsWith('/') ||
      value.startsWith('//') ||
      parsed.origin !== 'https://return.invalid' ||
      parsed.pathname !== '/connect' ||
      parsed.hash
    )
      return '/'
    const code = parsed.searchParams.get('code')
    return code && /^[A-Fa-f0-9]{10}$/.test(code)
      ? `/connect?code=${code.toUpperCase()}`
      : '/connect'
  } catch {
    return '/'
  }
}
