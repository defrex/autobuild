// Generated release catalog registry. Historical catalogs are immutable evidence.
import release0 from './1.2.0.json'
import release1 from './1.3.0.json'
import release2 from './1.4.0.json'
import type { ReducerValueCatalog } from '../../reducer-value-validation'
export interface ReleasedReducerValues extends ReducerValueCatalog {
  versions: Record<string, number>
}
export const RELEASED_REDUCER_VALUES: Readonly<Record<string, ReleasedReducerValues>> = {
  '1.2.0.json': release0,
  '1.3.0.json': release1,
  '1.4.0.json': release2,
}
