import '../ansi.css'
import './app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installClsProbe } from '../cls-probe'
import { useWebFrame } from './events'
import { AppShell } from './shell'

/* Literal of REPOSITORY_META in packages/core/src/web/protocol.ts. */
const repository =
  document.querySelector<HTMLMetaElement>('meta[name="ab-repository"]')?.content ?? ''

function App() {
  const frame = useWebFrame()
  return <AppShell repository={repository} frame={frame} path={location.pathname} />
}

installClsProbe()

/* Fonts load before the first render, so text never reflows when a face
   arrives; a slow face is waited on for at most 1.5 s. */
async function start() {
  const fonts = Promise.all([
    document.fonts.load('1em "Atkinson Hyperlegible Next"'),
    document.fonts.load('1em "JetBrains Mono"'),
  ])
  await Promise.race([fonts, new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => {})
  const root = document.getElementById('root')
  if (root)
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
}

void start()
