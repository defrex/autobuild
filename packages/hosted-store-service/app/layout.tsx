import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { ThemeProvider } from './ThemeProvider'
import { THEME_BOOTSTRAP } from './theme'
import type { ReactNode } from 'react'
import './globals.css'

const sans = localFont({
  src: './fonts/AtkinsonHyperlegibleNext.ttf',
  weight: '100 900',
  variable: '--font-sans',
  display: 'swap',
})
const mono = localFont({
  src: './fonts/JetBrainsMono.ttf',
  weight: '100 800',
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Autobuild operator',
  description: 'Watch and control Autobuild pipelines',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: constant validated preference bootstrap, with no user content */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
