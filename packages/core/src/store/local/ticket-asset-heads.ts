/**
 * The statements the local store's current-asset listing runs: a loose index
 * scan over the `ticket_assets` primary key `(repo, ticket_id, kind, name,
 * revision)` that visits each `(kind, name)` head once, whatever its history.
 *
 * Every next-name step is an equality prefix plus one `>` range, so each seek
 * lands past every revision of the previous name (or every row of the previous
 * kind). Do not merge the two next-name statements into an `OR` or a row-value
 * comparison: SQLite then constrains only `(repo, ticket_id)` and walks the
 * history. `store.integration.test.ts` pins each statement's query plan.
 */

export const FIRST_NAME =
  'SELECT kind, name FROM ticket_assets WHERE repo = ?1 AND ticket_id = ?2 ORDER BY kind, name LIMIT 1'

export const NEXT_NAME_SAME_KIND =
  'SELECT kind, name FROM ticket_assets WHERE repo = ?1 AND ticket_id = ?2 AND kind = ?3 AND name > ?4 ORDER BY name LIMIT 1'

export const FIRST_NAME_NEXT_KIND =
  'SELECT kind, name FROM ticket_assets WHERE repo = ?1 AND ticket_id = ?2 AND kind > ?3 ORDER BY kind, name LIMIT 1'

export const HEAD =
  'SELECT * FROM ticket_assets WHERE repo = ?1 AND ticket_id = ?2 AND kind = ?3 AND name = ?4 ORDER BY revision DESC LIMIT 1'
