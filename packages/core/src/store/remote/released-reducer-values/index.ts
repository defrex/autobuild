// Generated release catalog registry. Historical catalogs are immutable evidence.
import release120 from './1.2.0.json'
import release130 from './1.3.0.json'
import type { ReducerValueCatalog } from '../../reducer-value-validation'
export interface ReleasedReducerValues extends ReducerValueCatalog {
  versions: Record<string, number>
}
export const RELEASED_REDUCER_VALUES: Readonly<Record<string, ReleasedReducerValues>> = {
  '1.2.0.json': release120,
  '1.3.0.json': release130,
}
