import { AUTOBUILD_VERSION } from '@defrex/autobuild/remote-store'
import { z } from 'zod'

/** Fixed `type` field on every browser error log line; filter the runtime log on it. */
export const BROWSER_ERROR_MARKER = 'autobuild.browser-error'
/** Same-origin path the web app's head script posts reports to. */
export const BROWSER_ERROR_ENDPOINT = '/client-errors'
/** Bounds shared by the browser reporter, the endpoint and SELF-HOSTING.md. */
export const BROWSER_ERROR_LIMITS = {
  reportsPerPage: 5,
  bodyBytes: 16_384,
  message: 1_024,
  stack: 8_192,
  path: 512,
  userAgent: 512,
  deployment: 128,
} as const

/** The deployment that served a page: Vercel's or Next's deployment id, the
 * commit, or the Autobuild version for self-hosters without either. */
export function deploymentIdentity(env: Record<string, string | undefined>): string {
  for (const key of ['VERCEL_DEPLOYMENT_ID', 'NEXT_DEPLOYMENT_ID', 'VERCEL_GIT_COMMIT_SHA']) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return AUTOBUILD_VERSION
}

/** Synchronous inline `<head>` script. It must not depend on the application
 * bundle: the errors it exists for include a chunk failing while it evaluates,
 * before React mounts. Every global is reached through `window` so tests can
 * evaluate it against a fake. Reporting failures are swallowed. */
export function browserErrorBootstrap(deployment: string): string {
  const literal = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
  const limits = BROWSER_ERROR_LIMITS
  return `(function(){try{var w=window,u=${literal(BROWSER_ERROR_ENDPOINT)},d=${literal(
    deployment.slice(0, limits.deployment),
  )},n=0,seen={};function cut(v,m){v=v==null?'':String(v);return v.length>m?v.slice(0,m):v}function bytes(s){for(var i=0,b=0;i<s.length;i++){var c=s.charCodeAt(i);b+=c<128?1:c<2048?2:3}return b}function text(e){try{if(e&&typeof e.message==='string'&&e.message)return(e.name?e.name+': ':'')+e.message;return String(e)}catch(x){return 'Unknown error'}}function send(body){try{if(w.navigator&&w.navigator.sendBeacon&&w.Blob&&w.navigator.sendBeacon(u,new w.Blob([body],{type:'application/json'})))return}catch(x){}try{if(w.fetch){var p=w.fetch(u,{method:'POST',body:body,keepalive:true,credentials:'omit',headers:{'content-type':'application/json'}});if(p&&p.catch)p.catch(function(){})}}catch(x){}}function report(kind,message,stack){try{message=cut(message||'Unknown error',${limits.message});if(n>=${limits.reportsPerPage}||Object.prototype.hasOwnProperty.call(seen,message))return;seen[message]=1;n++;stack=stack?cut(stack,${limits.stack}):'';var body;for(;;){var r={kind:kind,message:message,path:cut(w.location&&w.location.pathname,${limits.path}),deployment:d};if(stack)r.stack=stack;body=JSON.stringify(r);if(!stack||bytes(body)<=${limits.bodyBytes})break;stack=stack.slice(0,stack.length>>1)}send(body)}catch(x){}}w.addEventListener('error',function(ev){try{var e=ev&&ev.error,s=e&&typeof e.stack==='string'?e.stack:'';if(!s&&ev&&ev.filename)s=ev.filename+':'+ev.lineno+':'+ev.colno;report('error',e&&typeof e.message==='string'&&e.message?text(e):(ev&&ev.message)||text(e),s)}catch(x){}});w.addEventListener('unhandledrejection',function(ev){try{var e=ev&&ev.reason;report('unhandledrejection',text(e),e&&typeof e.stack==='string'?e.stack:'')}catch(x){}});w.__autobuildReportBrowserError=function(e){try{report('boundary',text(e),e&&typeof e.stack==='string'?e.stack:'')}catch(x){}}}catch(e){}})()`
}

const reportSchema = z.object({
  kind: z.enum(['error', 'unhandledrejection', 'boundary']),
  message: z.string(),
  stack: z.string().optional(),
  path: z.string(),
  deployment: z.string().optional(),
})

const invalid = () =>
  Response.json({ error: 'invalid browser error report', kind: 'invalid' }, { status: 400 })
const tooLarge = () =>
  Response.json({ error: 'browser error report too large', kind: 'too-large' }, { status: 413 })
const failed = () =>
  Response.json({ error: 'browser error report failed', kind: 'internal' }, { status: 500 })

async function readBounded(req: Request, limit: number): Promise<Uint8Array | undefined> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return undefined
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Store-free: parses one bounded report and writes one log line. Rejections
 * never log or echo the request's content. */
export async function handleBrowserErrorReport(
  req: Request,
  options: { log: (line: string) => void; serverDeployment: string },
): Promise<Response> {
  try {
    const body = await readBounded(req, BROWSER_ERROR_LIMITS.bodyBytes)
    if (body === undefined) return tooLarge()
    let json: unknown
    try {
      json = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return invalid()
    }
    const parsed = reportSchema.safeParse(json)
    if (!parsed.success) return invalid()
    const report = parsed.data
    const limits = BROWSER_ERROR_LIMITS
    options.log(
      JSON.stringify({
        type: BROWSER_ERROR_MARKER,
        kind: report.kind,
        message: report.message.slice(0, limits.message),
        stack: report.stack?.slice(0, limits.stack),
        path: report.path.slice(0, limits.path),
        userAgent: (req.headers.get('user-agent') ?? '').slice(0, limits.userAgent),
        deployment: report.deployment?.slice(0, limits.deployment),
        serverDeployment: options.serverDeployment.slice(0, limits.deployment),
      }),
    )
    return new Response(null, { status: 204 })
  } catch {
    return failed()
  }
}
