import { hostedService } from '@autobuild/hosted-store-service/web/runtime'

async function machine(request: Request): Promise<Response> {
  return hostedService().fetch(request)
}

export const GET = machine
export const POST = machine
export const PUT = machine
export const PATCH = machine
export const DELETE = machine
export const HEAD = machine
export const OPTIONS = machine
