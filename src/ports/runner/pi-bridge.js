import { createBashTool } from '@earendil-works/pi-coding-agent'
import { installAutobuildBridge } from './pi-bridge-core.ts'

export default function autobuildBridge(pi) {
  installAutobuildBridge(pi, createBashTool)
}
