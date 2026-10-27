import { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT } from '../../machine'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Held event reads (AUT-334): the hosted event-wait ceiling is 25 s, so the
// route's function duration must cover the hold with margin.
export const maxDuration = 60
export { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT }
