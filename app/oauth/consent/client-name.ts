import { webAuth } from '@autobuild/hosted-store-service/web/auth'

/** How the consent page asks for a client's registered display name. */
export type ClientNameLookup = (clientId: string) => Promise<string | null>

/** The slice of the Better Auth context the lookup needs, typed structurally
 * so tests can stub it with a plain object (the real `await webAuth().$context`
 * is assignable to this shape). */
export interface AuthContextLike {
  adapter: {
    findOne(query: {
      model: string
      where: { field: string; value: string }[]
    }): Promise<{ name?: string | null } | null>
  }
}

/** Resolve the registered display name for an OAuth client id, or null when
 * no usable name exists. Maps a missing record, a blank name, and any adapter
 * error to null so the consent page can fall back to the raw client_id and
 * never error the consent flow. The `auth` default is lazily evaluated, so
 * importing this module never opens a pg Pool. */
export async function registeredClientName(
  clientId: string,
  auth: { $context: Promise<AuthContextLike> } = webAuth(),
): Promise<string | null> {
  try {
    const context = await auth.$context
    const client = await context.adapter.findOne({
      model: 'oauthApplication',
      where: [{ field: 'clientId', value: clientId }],
    })
    const name = client?.name?.trim()
    return name ? name : null
  } catch {
    return null
  }
}
